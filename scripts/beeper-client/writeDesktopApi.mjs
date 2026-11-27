// Inert write-adapter source. No CLI, service or cloud route imports/starts it.
// A separately reviewed per-message write authority must fence EVERY dispatch.
export class BeeperWriteApiError extends Error{constructor(code){super(code);this.code=code;}}
const deny=code=>{throw new BeeperWriteApiError(code);};
const ident=v=>typeof v==='string'&&v.length>0&&v.length<=2000&&!/[\u0000-\u001f\u007f]/u.test(v)&&!['.','..'].includes(v)?v:deny('source_incompatible');
export function createBeeperWriteClient({readWriteToken,fetchImpl=fetch,port=23373,timeoutMs=10000}={}){
 if(typeof readWriteToken!=='function'||!Number.isInteger(port)||port<1024||port>65535||!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>30000)deny('write_approval_required');
 const origin=`http://127.0.0.1:${port}`;
 async function request(method,path,body,beforeFetch){
  if(typeof beforeFetch!=='function')deny('write_approval_required');
  const token=await readWriteToken();if(typeof token!=='string'||!token||/[\r\n]/u.test(token))deny('source_authorization_required');
  let called=false,open=true,pending;
  const start=()=>{if(!open||called)deny('write_approval_required');called=true;return fetchImpl(new URL(path,origin),{method,headers:{Authorization:`Bearer ${token}`,Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(timeoutMs)});};
  try{pending=beforeFetch(start);}finally{open=false;}
  if(!called){void Promise.resolve(pending).catch(()=>{});deny('write_approval_required');}
  let response;try{response=await pending;}catch{deny('source_outcome_unknown');}
  if(!response.ok)deny(method==='POST'?'source_outcome_unknown':response.status===401||response.status===403?'source_authorization_required':'source_unavailable');
  if(!response.headers.get('content-type')?.includes('application/json'))deny('source_incompatible');
  const reader=response.body?.getReader();if(!reader)deny('source_incompatible');let bytes=0;const chunks=[];
  try{while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>256*1024){await reader.cancel();deny('source_incompatible');}chunks.push(value);}}
  catch(e){if(e instanceof BeeperWriteApiError)throw e;deny('source_outcome_unknown');}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{deny('source_incompatible');}
 }
 return Object.freeze({
  send:async(accountId,chatId,{text,replyToMessageId=null,beforeFetch}={})=>{
   ident(accountId);ident(chatId);if(typeof text!=='string'||!text.trim()||Buffer.byteLength(text,'utf8')>16000||replyToMessageId!==null&&typeof replyToMessageId!=='string')deny('source_incompatible');
   const base=`/v1/chats/${encodeURIComponent(chatId)}`;
   const current=await request('GET',base,undefined,beforeFetch);
   if(current?.id!==chatId||current?.accountID!==accountId||String(current.network).toLowerCase()!=='whatsapp')deny('source_incompatible');
   const body={text,...(replyToMessageId!==null?{replyToMessageID:ident(replyToMessageId)}:{})};
   const sent=await request('POST',base+'/messages',body,beforeFetch);
   if(sent?.chatID!==chatId||!ident(sent.pendingMessageID))deny('source_incompatible');
   return {chatID:chatId,pendingMessageID:sent.pendingMessageID};
  },
  retrieve:async(accountId,chatId,pendingId,{beforeFetch}={})=>{
   ident(accountId);ident(chatId);ident(pendingId);
   const value=await request('GET',`/v1/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(pendingId)}`,undefined,beforeFetch);
   if(value?.accountID!==accountId||value?.chatID!==chatId||value?.isSender!==true||!ident(value.id))deny('source_incompatible');
   return {id:value.id,accountID:accountId,chatID:chatId,isSender:true,sendStatus:{status:['SUCCESS','PENDING','FAIL_RETRIABLE','FAIL_PERMANENT'].includes(value.sendStatus?.status)?value.sendStatus.status:'PENDING'}};
  },
 });
}
