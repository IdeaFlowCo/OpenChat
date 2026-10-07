import { Router, type Request, type Response, type NextFunction } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getConnectorPrincipal } from '../lib/ideaflowConnector.js';
import { getDriver } from '../db.js';
import { ContextLaneError } from '../services/contextLane.js';
import { hostedPreference, listHostedRequests, getHostedRequest, reviseHostedRequest, publishHostedRequest, stopHostedRequest } from '../services/contextHosted.js';
const router=Router();
// Raw session JWT validation is essential: connector principals have no agentKeyId.
router.use(requireAuth,(req:Request,res:Response,next:NextFunction)=>{
  if(req.agentKeyId||req.connectorDelegation||getConnectorPrincipal(req)||req.user?.embedded){res.status(403).json({error:'A direct human session is required to review hosted Context drafts'});return;}
  next();
});
const handle=(action:(req:Request,session:ReturnType<ReturnType<typeof getDriver>['session']>)=>Promise<unknown>)=>async(req:Request,res:Response)=>{
  const session=getDriver().session();res.set('Cache-Control','no-store');
  try{res.json(await action(req,session));}
  catch(error:any){if(error instanceof ContextLaneError)res.status(error.statusCode).json({error:error.message});else{console.warn('[context-hosted] request failed');res.status(500).json({error:'Hosted Context request failed'});}}
  finally{await session.close();}
};
router.get('/preferences',handle((req,s)=>hostedPreference(s,req.user!.userId)));
router.put('/preferences',handle((req,s)=>{
  if(typeof req.body?.enabled!=='boolean')throw new ContextLaneError(400,'enabled must be a boolean');
  return hostedPreference(s,req.user!.userId,req.body.enabled);
}));
router.get('/requests',handle((req,s)=>{
  if(req.query.conversationId!==undefined&&typeof req.query.conversationId!=='string')throw new ContextLaneError(400,'conversationId must be a single string');
  return listHostedRequests(s,req.user!.userId,req.query.conversationId as string|undefined);
}));
router.get('/requests/:id',handle((req,s)=>getHostedRequest(s,req.user!.userId,String(req.params.id))));
router.post('/requests/:id/revise',handle((req,s)=>reviseHostedRequest(s,req.user!.userId,String(req.params.id),{text:req.body?.text,privateText:req.body?.privateText})));
router.post('/requests/:id/publish',handle((req,s)=>publishHostedRequest(s,req.user!.userId,String(req.params.id),{draftId:req.body?.draftId,approvalDigest:req.body?.approvalDigest,text:req.body?.text})));
router.post('/requests/:id/decline',handle((req,s)=>stopHostedRequest(s,req.user!.userId,String(req.params.id),'declined')));
router.post('/requests/:id/cancel',handle((req,s)=>stopHostedRequest(s,req.user!.userId,String(req.params.id),'cancelled')));
export default router;
