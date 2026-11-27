import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtempSync,mkdirSync,chmodSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';import{join}from'node:path';import{DatabaseSync}from'node:sqlite';import{randomBytes}from'node:crypto';import nacl from'tweetnacl';
const m=vi.hoisted(()=>({stopInToken:false,source:vi.fn(),relay:vi.fn(),confirm:vi.fn(async()=>true)}));
vi.mock('../../../scripts/beeper-client/desktopApi.mjs',async()=>{
 const actual=await vi.importActual<any>('../../../scripts/beeper-client/desktopApi.mjs');
 return {...actual,createBeeperReadonlyClient:(options:any)=>actual.createBeeperReadonlyClient({...options,readToken:async()=>{if(m.stopInToken)process.emit('SIGINT');return 'synthetic-source-token';},fetchImpl:m.source})};
});
vi.mock('../../../scripts/beeper-client/readAuthority.mjs',async()=>{
 const actual=await vi.importActual<any>('../../../scripts/beeper-client/readAuthority.mjs');return {...actual,confirmBeeperLocally:m.confirm};
});
import{BeeperReadAuthority}from'../../../scripts/beeper-client/readAuthority.mjs';
import{BeeperForegroundLease,main}from'../../../scripts/beeper-client/foreground.mjs';
let root:string,paired:string,state:string,db:DatabaseSync,authority:BeeperReadAuthority,mask:number;
const pairRoute=randomBytes(24).toString('hex'),key=()=>{const k=nacl.box.keyPair();return {pub:Buffer.from(k.publicKey).toString('hex'),secret:Buffer.from(k.secretKey).toString('hex')};};
const machine=key(),device=key();let input:PropertyDescriptor|undefined,output:PropertyDescriptor|undefined;
beforeEach(()=>{
 mask=process.umask();root=mkdtempSync(join(tmpdir(),'beeper-cli-regression-'));paired=join(root,'paired');state=join(root,'state');mkdirSync(paired,{mode:0o700});const f=join(paired,'authority.db');db=new DatabaseSync(f);chmodSync(f,0o600);db.exec('CREATE TABLE machine(id,pub,secret);CREATE TABLE grants(route,device,expires,state,context,relayTicket)');db.prepare('INSERT INTO machine VALUES(1,?,?)').run(machine.pub,machine.secret);db.prepare("INSERT INTO grants VALUES(?,?,?,'active','synthetic','synthetic')").run(pairRoute,device.pub,Date.now()+3600000);authority=new BeeperReadAuthority({directory:state,pairingDirectory:paired});
 input=Object.getOwnPropertyDescriptor(process.stdin,'isTTY');output=Object.getOwnPropertyDescriptor(process.stdout,'isTTY');Object.defineProperty(process.stdin,'isTTY',{configurable:true,value:true});Object.defineProperty(process.stdout,'isTTY',{configurable:true,value:true});m.stopInToken=false;vi.clearAllMocks();vi.stubGlobal('fetch',m.relay);
});
afterEach(()=>{authority.close();db.close();if(input)Object.defineProperty(process.stdin,'isTTY',input);else delete(process.stdin as any).isTTY;if(output)Object.defineProperty(process.stdout,'isTTY',output);else delete(process.stdout as any).isTTY;process.umask(mask);vi.unstubAllGlobals();rmSync(root,{recursive:true,force:true});});
const approve=()=>authority.approveCatalogue({pairRoute,ownerId:'synthetic-owner',accountId:'synthetic-account',expiresAt:Date.now()+1800000,destination:'https://chat.ideaflow.app'},async()=>true);
it('runs the actual revoke command while a foreground process lease is held and revokes its active connection',async()=>{
 const approved=await approve(),lease=new BeeperForegroundLease(state);try{
  await main(['revoke','--directory',state,'--pairing-directory',paired,'--grant',approved.publicOffer.connectionId]);
  await expect(authority.readCatalogue(approved.publicOffer.connectionId,{chats:m.source},m.relay)).rejects.toThrow();expect(m.source).not.toHaveBeenCalled();expect(m.relay).not.toHaveBeenCalled();
 }finally{lease.close();}
});
it.each(['catalogue','approve-chat'])('actual %s CLI wires its stop signal through async source credential lookup before any GET',async(command)=>{
 const approved=await approve(),id=approved.publicOffer.connectionId;
 writeFileSync(join(state,id+'.json'),JSON.stringify({version:1,connectionId:id,pairRoute,accountId:'synthetic-account',keychain:{service:'synthetic',account:'synthetic'},relayToken:approved.relayToken}),{mode:0o600,flag:'wx'});
 m.stopInToken=true;
 const args=[command,'--directory',state,'--pairing-directory',paired,'--connection',id,...(command==='approve-chat'?['--chat','synthetic-chat']:[])];
 await expect(main(args)).rejects.toMatchObject({code:'stopped'});expect(m.confirm).toHaveBeenCalled();expect(m.source).not.toHaveBeenCalled();expect(m.relay).not.toHaveBeenCalled();
 // Every failure path must release the process lease for a clean successor.
 new BeeperForegroundLease(state).close();
});
