import { Router, type Response } from 'express';
import { getDriver } from '../db.js';
import { requireAuth, requireDirectHumanSession } from '../middleware/auth.js';
import { ensureCapturedPerson } from '../services/privateGraph.js';
import { createHash } from 'node:crypto';
import { CaptureError, addCapture, authenticateCaptureDevice, createCaptureDevice, forgetCapture, ingestCaptures, listCaptures, listCaptureThreads, updateCapture } from '../services/messageCaptures.js';

const router=Router();
router.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
const fail=(error:unknown,res:Response)=>{
  if(error instanceof CaptureError){res.status(error.status).json({error:error.message});return;}
  console.warn('[message-captures] operation failed');
  res.status(500).json({error:'Could not access saved messages'});
};

// Dedicated write-only credential. Existing general agent/connector credentials
// cannot ingest, enumerate or read this private archive.
router.post('/ingest',async(req,res)=>{
  const session=getDriver().session();
  try {
    const owner=await authenticateCaptureDevice(session,(req.headers.authorization||'').replace(/^Bearer /,''));
    res.json(await ingestCaptures(session,owner,req.body?.captures));
  }catch(error){fail(error,res);}finally{await session.close();}
});
router.use(requireAuth);
router.use(requireDirectHumanSession);
router.get('/',async(req,res)=>{
  const session=getDriver().session();
  try{
    const {threadId,search,cursor,limit,destination}=req.query;
    if([threadId,search,cursor,limit,destination].some(v=>v!==undefined&&typeof v!=='string') || (limit!==undefined&&!/^\d+$/.test(String(limit)))) throw new CaptureError(400,'Invalid query');
    res.json(await listCaptures(session,req.user!.userId,{threadId:threadId as string,search:search as string,cursor:cursor as string,destination:destination as string,limit:limit===undefined?undefined:Number(limit)}));
  }catch(error){fail(error,res);}finally{await session.close();}
});
router.post('/',async(req,res)=>{
  const session=getDriver().session();
  try{res.status(201).json(await addCapture(session,req.user!.userId,req.body));}catch(error){fail(error,res);}finally{await session.close();}
});
router.get('/threads',async(req,res)=>{
  const session=getDriver().session();
  try{res.json({threads:await listCaptureThreads(session,req.user!.userId)});}catch(error){fail(error,res);}finally{await session.close();}
});
router.post('/threads/:id/person',async(req,res)=>{
  const session=getDriver().session(),ownerId=req.user!.userId;
  try{
    const result=await session.run('MATCH (t:OpenChatCaptureThread {id:$id,ownerId:$ownerId}) RETURN t',{id:String(req.params.id),ownerId});
    const thread=result.records[0]?.get('t').properties;
    if(!thread || thread.participants?.length!==1)throw new CaptureError(404,'Choose a person conversation');
    const sourceRef=createHash('sha256').update(JSON.stringify([thread.channel,thread.sourceAccount,thread.participants[0]])).digest('hex');
    const person=await ensureCapturedPerson(ownerId,thread.title.slice(0,120),sourceRef);
    await session.run('MATCH (t:OpenChatCaptureThread {id:$id,ownerId:$ownerId}) SET t.personId=$personId',{id:String(req.params.id),ownerId,personId:person.id});
    res.json({person});
  }catch(error){fail(error,res);}finally{await session.close();}
});
router.post('/devices',async(req,res)=>{
  const session=getDriver().session();
  try{res.status(201).json(await createCaptureDevice(session,req.user!.userId,req.body?.name));}catch(error){fail(error,res);}finally{await session.close();}
});
router.get('/devices',async(req,res)=>{
  const session=getDriver().session();
  try{
    const result=await session.run(`MATCH (d:OpenChatCaptureDevice {ownerId:$ownerId}) WHERE d.revokedAt IS NULL
      RETURN d.id AS id,d.name AS name,d.createdAt AS createdAt,d.lastSeenAt AS lastSeenAt ORDER BY createdAt DESC`,{ownerId:req.user!.userId});
    res.json({devices:result.records.map(r=>r.toObject())});
  }catch(error){fail(error,res);}finally{await session.close();}
});
router.delete('/devices/:id',async(req,res)=>{
  const session=getDriver().session();
  try{await session.run('MATCH (d:OpenChatCaptureDevice {ownerId:$ownerId,id:$id}) SET d.revokedAt=$now REMOVE d.tokenHash',{ownerId:req.user!.userId,id:String(req.params.id),now:new Date().toISOString()});res.json({revoked:true});}catch(error){fail(error,res);}finally{await session.close();}
});
router.patch('/:id',async(req,res)=>{
  const session=getDriver().session();
  try{res.json(await updateCapture(session,req.user!.userId,String(req.params.id),req.body));}catch(error){fail(error,res);}finally{await session.close();}
});
router.delete('/:id',async(req,res)=>{
  const session=getDriver().session();
  try{res.json(await forgetCapture(session,req.user!.userId,String(req.params.id)));}catch(error){fail(error,res);}finally{await session.close();}
});
export default router;
