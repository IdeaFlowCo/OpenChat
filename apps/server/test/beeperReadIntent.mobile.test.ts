import {afterEach,expect,it,vi} from 'vitest';
vi.mock('expo-crypto',()=>({getRandomBytesAsync:async()=>new Uint8Array(16).fill(7)}));
import {authorizeBeeperRead,installReviewedBeeperReadResolver,type LocalBeeperReadCapability} from '../../mobile/src/services/beeper/readIntent';
const connection={id:'1'.repeat(48),machineKey:'2'.repeat(64),deviceKey:'3'.repeat(64),accountKey:'4'.repeat(64),state:'active',expiresAt:new Date(Date.now()+86400000).toISOString()};
const chat={chatKey:'5'.repeat(64),title:'Synthetic chat',chatType:'group'};
const job={id:'6'.repeat(48),epoch:1,state:'pending',kind:'open'};
let clear:(()=>void)|undefined;afterEach(()=>{clear?.();clear=undefined;});
const frame=Buffer.alloc(48,8).toString('base64');
const grant=(changes:Partial<LocalBeeperReadCapability>={}):LocalBeeperReadCapability=>({protocol:'openchat.beeper.read.v1',ownerId:'owner',route:connection.id,audience:'beeper.read',machineKey:connection.machineKey,deviceKey:connection.deviceKey,accountKey:connection.accountKey,chatKey:chat.chatKey,grantId:'7'.repeat(48),expiresAt:Date.now()+600000,sealRead:vi.fn(async()=>frame),...changes});
it('fails closed without a reviewed local device resolver and never invents machine authority',async()=>{
 await expect(authorizeBeeperRead(connection as any,job as any,chat as any,'owner')).rejects.toMatchObject({code:'beeper_secure_grant_required'});
});
it('binds typed read requests to the locally pinned route, device, machine, exact source and destination',async()=>{
 const local=grant();clear=installReviewedBeeperReadResolver(async scope=>{expect(scope).toEqual({ownerId:'owner',route:connection.id,audience:'beeper.read',machineKey:connection.machineKey,deviceKey:connection.deviceKey,accountKey:connection.accountKey,chatKey:chat.chatKey});return local;});
 expect(await authorizeBeeperRead(connection as any,job as any,chat as any,'owner')).toBe(frame);
 expect(local.sealRead).toHaveBeenCalledWith(expect.objectContaining({protocol:'openchat.beeper.read.v1',ownerId:'owner',route:connection.id,audience:'beeper.read',destination:'https://chat.ideaflow.app',machineKey:connection.machineKey,deviceKey:connection.deviceKey,accountKey:connection.accountKey,chatKey:chat.chatKey,connectionId:connection.id,jobId:job.id,epoch:1,grantId:local.grantId,operation:'readSelected'}));
});
it.each(['ownerId','route','machineKey','deviceKey','accountKey','chatKey','audience'] as const)('rejects a different local %s before sealing',async key=>{
 const local=grant({[key]:'different'});clear=installReviewedBeeperReadResolver(async()=>local);
 await expect(authorizeBeeperRead(connection as any,job as any,chat as any,'owner')).rejects.toMatchObject({code:'beeper_secure_grant_required'});expect(local.sealRead).not.toHaveBeenCalled();
});
it('rejects stale account/registry results at both asynchronous boundaries',async()=>{
 let done!:(value:LocalBeeperReadCapability)=>void;clear=installReviewedBeeperReadResolver(()=>new Promise(resolve=>{done=resolve;}));
 const pending=authorizeBeeperRead(connection as any,job as any,chat as any,'owner');clear();done(grant());await expect(pending).rejects.toMatchObject({code:'beeper_secure_grant_required'});
 let finish!:(value:string)=>void;const local=grant({sealRead:()=>new Promise(resolve=>{finish=resolve;})});clear=installReviewedBeeperReadResolver(async()=>local);
 const sealed=authorizeBeeperRead(connection as any,job as any,chat as any,'owner');await Promise.resolve();await Promise.resolve();clear();finish(frame);await expect(sealed).rejects.toMatchObject({code:'beeper_secure_grant_required'});
});

it('requires the relay label to match the independently authenticated local network before sealing',async()=>{
 const local=grant({display:{title:chat.title,chatType:chat.chatType,network:'imessage'}});clear=installReviewedBeeperReadResolver(async()=>local);
 await expect(authorizeBeeperRead(connection as any,job as any,{...chat,network:'whatsapp'} as any,'owner')).rejects.toMatchObject({code:'beeper_secure_grant_required'});
 expect(local.sealRead).not.toHaveBeenCalled();
 expect(await authorizeBeeperRead(connection as any,job as any,{...chat,network:'imessage'} as any,'owner')).toBe(frame);
});
