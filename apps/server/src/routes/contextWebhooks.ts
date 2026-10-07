import { Router,type Request,type Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getConnectorPrincipal } from '../lib/ideaflowConnector.js';
import { getDriver } from '../db.js';
import { ContextLaneError } from '../services/contextLane.js';
import { createContextWebhook,listContextWebhooks,deleteContextWebhook } from '../services/contextWebhooks.js';
const router=Router();
router.use(requireAuth,(req:Request,res:Response,next:()=>void)=>{
 if(req.agentKeyId||req.connectorDelegation||getConnectorPrincipal(req)||req.user?.embedded){res.status(403).json({error:'Use a direct human session to approve Context webhook destinations'});return;}next();
});
const handle=(fn:(req:Request,s:ReturnType<ReturnType<typeof getDriver>['session']>)=>Promise<unknown>)=>async(req:Request,res:Response)=>{
 const s=getDriver().session();res.set('Cache-Control','no-store');try{res.json(await fn(req,s));}catch(e){if(e instanceof ContextLaneError)res.status(e.statusCode).json({error:e.message});else{console.warn('[context-webhooks] request failed');res.status(500).json({error:'Context webhook request failed'});}}finally{await s.close();}
};
router.get('/',handle((req,s)=>listContextWebhooks(s,req.user!.userId)));
router.post('/',handle((req,s)=>{
 if(!req.body||Object.keys(req.body).some(k=>!['url','conversationId','agentKeyId','clientRequestId','consent'].includes(k)))throw new ContextLaneError(400,'Unsupported subscription fields');
 return createContextWebhook(s,req.user!.userId,req.body);
}));
router.delete('/:id',handle((req,s)=>deleteContextWebhook(s,req.user!.userId,String(req.params.id))));
export default router;
