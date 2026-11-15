import { withConversationLock } from '../services/conversationLock.js';
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
      await withConversationLock(result.conversationId, async tx => {
        const current = await tx.run(`MATCH(s:UnlinkedGroupSync {conversationId:$id}) RETURN s.revision AS revision,s.pendingRemoved AS removed`, { id:result.conversationId });
        if (!current.records.length || Number(current.records[0].get('revision')) !== result.revision) return;
        const removed = (current.records[0].get('removed') ?? []) as string[];
        for (const id of removed) {
          leaveUserSocketsFromConversation(io,id,result.conversationId);
          io.to(`user:${id}`).emit('participant:removed',{conversationId:result.conversationId,userId:id});
        }
        const conversation = await loadConversation(tx,result.conversationId);
        const participants = (conversation?.participants ?? []) as Array<{user:{id:string}}>;
        for (const {user} of participants) {
          if (await joinUserSocketsToConversation(io,user.id,result.conversationId,tx)) {
            io.to(`user:${user.id}`).emit('conversation:created',{conversationId:result.conversationId,conversation});
          }
        }
        await tx.run(`MATCH(s:UnlinkedGroupSync {conversationId:$id}) SET s.pendingRemoved=[]`, { id:result.conversationId });
      });
    }
    res.json({conversationId:result.conversationId,revision:result.revision});
  } catch(error) {
    if(error instanceof UnlinkedGroupError) {res.status(error.status).json({error:error.message});return;}
    res.status(503).json({error:'group_sync_unavailable'});
  }
});
export default router;
