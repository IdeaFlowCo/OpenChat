import express,{Router,type Request,type Response,type NextFunction} from 'express';
import {requireAuth,requireDirectSession} from '../middleware/auth.js';
import {ImportedChatError} from '../services/importedChats.js';
import {BeeperRelayError,approveBeeperReadConnection,listBeeperReadConnections,revokeBeeperReadConnection,
  listBeeperCatalogue,requestBeeperRead,attachBeeperReadIntent,readBeeperJob,verifyBeeperRelayToken,
  publishBeeperCatalogue,claimBeeperRead,resumeBeeperRead,deliverBeeperRead,failBeeperRead} from '../services/beeperRelay.js';

function failure(error:unknown,res:Response){
  if(error instanceof BeeperRelayError){res.status(error.status).json({error:error.code});return;}
  if(error instanceof ImportedChatError){res.status(error.status).json({error:'source_reconciliation_required'});return;}
  console.error('Beeper request failed:',error instanceof Error?error.name:'unknown');
  res.status(500).json({error:'beeper_request_failed'});
}
function handler(action:(req:Request)=>Promise<unknown>,status=200){
  return async(req:Request,res:Response)=>{try{res.status(status).json(await action(req));}catch(e){failure(e,res);}};
}
const noStore=(_req:Request,res:Response,next:NextFunction)=>{res.set('Cache-Control','no-store');next();};
export const beeperOwnerRoutes=Router();
beeperOwnerRoutes.use(requireAuth,requireDirectSession,noStore);
const owner=(req:Request)=>req.user!.userId;
const cid=(req:Request)=>req.params.connectionId as string;
beeperOwnerRoutes.get('/connections',handler(req=>listBeeperReadConnections(owner(req))));
// This is an explicit person approval of a public offer created locally on the Mac.
// It does not create Mac keys, a local grant, a listener or a source account connection.
beeperOwnerRoutes.post('/connections',handler(req=>approveBeeperReadConnection(owner(req),req.body?.offer),201));
beeperOwnerRoutes.delete('/connections/:connectionId',handler(req=>revokeBeeperReadConnection(owner(req),cid(req))));
beeperOwnerRoutes.get('/connections/:connectionId/chats',handler(req=>listBeeperCatalogue(owner(req),cid(req),{cursor:req.query.cursor,search:req.query.search,chatKey:req.query.chatKey})));
beeperOwnerRoutes.post('/connections/:connectionId/reads',handler(req=>requestBeeperRead(owner(req),cid(req),req.body),201));
beeperOwnerRoutes.put('/connections/:connectionId/reads/:jobId/intent',handler(req=>attachBeeperReadIntent(owner(req),cid(req),req.params.jobId as string,req.body?.frame)));
beeperOwnerRoutes.get('/connections/:connectionId/reads/:jobId',handler(req=>readBeeperJob(owner(req),cid(req),req.params.jobId as string)));

export const beeperRelayRoutes=Router();
const tokens=new WeakMap<Request,string>();
beeperRelayRoutes.use(noStore,async(req:Request,res:Response,next:NextFunction)=>{
  const authorization=req.headers.authorization;
  if(!authorization?.startsWith('Bearer ocbr_')){res.status(401).json({error:'relay_not_authorized'});return;}
  const token=authorization.slice(7);
  try{await verifyBeeperRelayToken(token);tokens.set(req,token);next();}catch(e){failure(e,res);}
});
beeperRelayRoutes.post('/catalogue',handler(req=>publishBeeperCatalogue(tokens.get(req)!,req.body)));
beeperRelayRoutes.post('/claim',handler(req=>claimBeeperRead(tokens.get(req)!)));
beeperRelayRoutes.post('/resume',handler(req=>resumeBeeperRead(tokens.get(req)!,req.body)));
beeperRelayRoutes.post('/fail',handler(req=>failBeeperRead(tokens.get(req)!,req.body)));
// Authentication precedes the larger parser. The service rechecks the grant
// under its write locks after parsing, including revocation during an upload.
beeperRelayRoutes.post('/deliver',express.json({limit:'1mb'}),handler(req=>deliverBeeperRead(tokens.get(req)!,req.body)));
