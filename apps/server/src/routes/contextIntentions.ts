import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getConnectorPrincipal } from '../lib/ideaflowConnector.js';
import { isContextLaneEnabled } from '../config/features.js';
import { getDriver } from '../db.js';
import { ContextLaneError } from '../services/contextLane.js';
import { getContextIntention,listContextIntentions,trackContextIntention,updateContextIntention } from '../services/contextIntentions.js';
const router=Router();
// Approval is a direct human action; trusted connector principals are not human sessions.
const human=[requireAuth,(req:Request,res:Response,next:()=>void)=>{
  if(!isContextLaneEnabled()){res.status(404).json({error:'Context is unavailable'});return;}
  if(req.user?.embedded||req.agentKeyId||req.connectorDelegation||getConnectorPrincipal(req)){res.status(403).json({error:'Use a direct human session to manage intentions'});return;}
  next();
}];
const handle=(action:(req:Request,s:ReturnType<ReturnType<typeof getDriver>['session']>)=>Promise<unknown>)=>async(req:Request,res:Response)=>{
  const s=getDriver().session();res.set('Cache-Control','no-store');
  try{res.json(await action(req,s));}catch(error){if(error instanceof ContextLaneError)res.status(error.statusCode).json({error:error.message});else{console.warn('[context-intentions] request failed');res.status(500).json({error:'Could not update intention'});}}finally{await s.close();}
};
router.get('/context-intentions',...human,handle((req,s)=>listContextIntentions(s,req.user!.userId)));
router.get('/context-intentions/:id',...human,handle((req,s)=>getContextIntention(s,req.user!.userId,String(req.params.id))));
router.post('/conversations/:conversationId/context/:postId/intention',...human,handle((req,s)=>{
  if(!req.body||Object.keys(req.body).some(k=>!['sourceRevision','clientRequestId','intentId'].includes(k)))throw new ContextLaneError(400,'Unsupported tracking fields');
  return trackContextIntention(s,req.user!.userId,String(req.params.conversationId),String(req.params.postId),req.body);
}));
router.patch('/context-intentions/:id',...human,handle((req,s)=>{
  if(!req.body||Object.keys(req.body).some(k=>!['expectedRevision','lifecycleState'].includes(k)))throw new ContextLaneError(400,'Unsupported lifecycle fields');
  return updateContextIntention(s,req.user!.userId,String(req.params.id),req.body);
}));
export default router;
