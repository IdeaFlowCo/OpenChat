import { Router } from 'express';
import { resolveActor } from '../middleware/resolveActor.js';
import { connectVision, parseSaveRequest, reviewVisionSave, saveToVision, visionSaveMarker } from '../services/visionSave.js';
const router=Router();
router.use(resolveActor,(req,res,next)=>{res.set('Cache-Control','no-store');if(req.agentScopes||req.connectorDelegation){res.status(403).json({status:'rejected',reason:'Use an explicit authenticated user Save action'});return;}next();});
router.post('/connection',async(req,res)=>{try{res.json(await connectVision(req.user!.userId));}catch{res.status(503).json({status:'unavailable',reason:'Vision connection unavailable; selection retained'});}});
router.post('/saves/review',async(req,res)=>{const input=parseSaveRequest(req.body);if(!input){res.status(400).json({status:'rejected',reason:'Invalid private save selection'});return;}try{res.json(await reviewVisionSave(req.user!.userId,input));}catch{res.status(503).json({status:'unavailable',reason:'Review unavailable; selection retained. No new save was started'});}});
router.post('/saves',async(req,res)=>{const input=parseSaveRequest(req.body);if(!input){res.status(400).json({status:'rejected',reason:'Invalid private save selection'});return;}try{res.json(await saveToVision(req.user!.userId,input));}catch{res.status(503).json({status:'uncertain',reason:'Receipt unavailable; do not save again automatically. Check Vision for '+visionSaveMarker(req.user!.userId,input.idempotencyKey)});}});
export default router;
