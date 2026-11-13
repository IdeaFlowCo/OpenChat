import { getDriver } from '../db.js';
import { loadConversation } from './chat.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import type { Server } from 'socket.io';
import { parseGroupSnapshot, syncUnlinkedGroup, UnlinkedGroupError } from '../services/unlinkedGroups.js';
import { joinUserSocketsToConversation, leaveUserSocketsFromConversation } from '../websocket/chatHandler.js';
const router=Router();
router.post('/unlinked/groups/sync',async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const secret=process.env.UNLINKED_MESSAGING_SECRET;
  if(!secret || secret.length<32) {res.status(503).json({error:'group_sync_unavailable'});return;}
  if(req.headers.origin) {res.status(403).json({error:'forbidden'});return;}
  const hash=(s:string)=>createHash('sha256').update(s).digest();
  if(!timingSafeEqual(hash(req.headers.authorization??''),hash(`Bearer ${secret}`))) {res.status(401).json({error:'unauthorized'});return;}
  try {
    const result=await syncUnlinkedGroup(parseGroupSnapshot(req.body));
    const io=req.app.get('io') as Server|undefined;
    if(io) {
      const session=getDriver().session();
      let conversation;
      try {conversation=await loadConversation(session,result.conversationId);} finally {await session.close();}
      for(const id of result.removed) {leaveUserSocketsFromConversation(io,id,result.conversationId);io.to(`user:${id}`).emit('participant:removed',{conversationId:result.conversationId,userId:id});}
      for(const id of result.added) joinUserSocketsToConversation(io,id,result.conversationId);
      for(const id of result.participants) io.to(`user:${id}`).emit(result.added.includes(id)?'conversation:created':'conversation:updated',{conversationId:result.conversationId,conversation});
    }
    res.json({conversationId:result.conversationId,revision:result.revision});
  } catch(error) {
    if(error instanceof UnlinkedGroupError) {res.status(error.status).json({error:error.message});return;}
    res.status(503).json({error:'group_sync_unavailable'});
  }
});
export default router;
