import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import {createCipheriv,randomBytes} from 'node:crypto';
import {beforeEach,describe,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({list:vi.fn(),create:vi.fn(),remove:vi.fn(),run:vi.fn()}));
vi.mock('../src/db.js',()=>({getDriver:()=>({session:()=>({run:state.run,close:async()=>{}})})}));
vi.mock('../src/services/contextWebhooks.js',()=>({listContextWebhooks:state.list,createContextWebhook:state.create,deleteContextWebhook:state.remove}));
import routes from '../src/routes/contextWebhooks.js';
import {connectorOperationGuard} from '../src/routes/ideaflowConnector.js';
import {issueConnectorOperation,getConnectorPrincipal} from '../src/lib/ideaflowConnector.js';
import {resolveActor} from '../src/middleware/resolveActor.js';
const base='/api/chat/context-webhooks',app=express();let trusted=false;
app.use(express.json());app.use('/api',connectorOperationGuard);app.use((req,_res,next)=>{trusted=!!getConnectorPrincipal(req);next();});
app.get('/api/key-probe',resolveActor,(req,res)=>res.json({userId:req.user!.userId}));app.use(base,routes);
const token=(extra:Record<string,unknown>={})=>jwt.sign({userId:'reviewer',email:'synthetic@example.invalid',...extra},process.env.JWT_SECRET!,{expiresIn:60});
describe('Context webhook destination consent human boundary',()=>{
 beforeEach(()=>{vi.clearAllMocks();trusted=false;process.env.JWT_SECRET='test-only-context-webhook-jwt';state.list.mockResolvedValue({subscriptions:[],available:true});state.create.mockResolvedValue({subscription:{id:'created'},secret:'synthetic'});state.remove.mockResolvedValue({deleted:true});});
 it('accepts a real human JWT and binds consent to that owner',async()=>{
  const response=await request(app).get(base).set('Authorization',`Bearer ${token()}`);expect(response.status).toBe(200);expect(response.headers['cache-control']).toBe('no-store');expect(state.list).toHaveBeenCalledWith(expect.anything(),'reviewer');
  const input={url:'https://example.invalid/wake',conversationId:'room',agentKeyId:'key',consent:true,clientRequestId:'once'};
  expect((await request(app).post(base).set('Authorization',`Bearer ${token()}`).send(input)).status).toBe(200);expect(state.create).toHaveBeenCalledWith(expect.anything(),'reviewer',input);
  expect((await request(app).post(base).set('Authorization',`Bearer ${token()}`).send({...input,ownerUserId:'victim'})).status).toBe(400);
 });
 it('rejects a genuine encrypted agent key that authenticates normal agent reads',async()=>{
  const encryption=randomBytes(32);process.env.OC_KEY_ENCRYPTION_SECRET=encryption.toString('hex');
  const key='oc_'+randomBytes(24).toString('base64url'),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',encryption,iv);
  const ciphertext=Buffer.concat([cipher.update(key,'utf8'),cipher.final(),cipher.getAuthTag()]).toString('hex');
  const fields:Record<string,unknown>={keyCiphertext:ciphertext,keyIv:iv.toString('hex'),keyId:'valid-key',ownerUserId:'reviewer',expiresAt:null,scopes:['read','write']};
  state.run.mockResolvedValue({records:[{get:(name:string)=>fields[name]}]});
  expect((await request(app).get('/api/key-probe').set('Authorization',`Bearer ${key}`)).status).toBe(200);
  for(const method of ['get','post','delete'] as const){const response=await request(app)[method](base+(method==='delete'?'/existing':'')).set('Authorization',`Bearer ${key}`).send(method==='post'?{consent:true}:undefined);expect(response.status).toBe(401);}
  expect(state.list).not.toHaveBeenCalled();expect(state.create).not.toHaveBeenCalled();expect(state.remove).not.toHaveBeenCalled();
 });
 it('rejects valid connector operations and embedded sessions for read/create/delete',async()=>{
  for(const method of ['GET','POST','DELETE'] as const){const path=base+(method==='DELETE'?'/existing':''),body=method==='POST'?{consent:true}:undefined;
   const operation=issueConnectorOperation('reviewer',{method,path,...(body?{body}:{})},['openchat:read','openchat:write']);
   expect((await request(app)[method.toLowerCase() as 'get'|'post'|'delete'](path).set('Authorization',`Bearer ${operation}`).send(body)).status).toBe(401);expect(trusted).toBe(true);
   expect((await request(app)[method.toLowerCase() as 'get'|'post'|'delete'](path).set('Authorization',`Bearer ${token({embedded:'unlinked'})}`).send(body)).status).toBe(403);
  }
  expect(state.list).not.toHaveBeenCalled();expect(state.create).not.toHaveBeenCalled();expect(state.remove).not.toHaveBeenCalled();
 });
});
