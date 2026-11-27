// Fixed destination, dedicated WRITE transport credential. It grants no Mac operation.
export class BeeperWriteTransportError extends Error{constructor(code,status=0){super(code);this.code=code;this.status=status;}}
const deny=(code,status=0)=>{throw new BeeperWriteTransportError(code,status);};
export function createBeeperWriteRelay({readToken,signal,fetchImpl=fetch,timeoutMs=10000}={}){
 if(typeof readToken!=='function'||!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>30000)deny('write_configuration_required');
 async function post(endpoint,body,beforeFetch){
  const encoded=JSON.stringify(body);if(Buffer.byteLength(encoded)>180*1024)deny('write_transport_too_large');
  const token=await readToken();if(!/^ocbs_[A-Za-z0-9_-]{43}$/.test(token))deny('write_authorization_required');if(signal?.aborted)deny('write_stopped');
  let open=true,called=false,pending;const start=()=>{if(!open||called)deny('write_disclosure_denied');if(signal?.aborted)deny('write_stopped');called=true;return fetchImpl('https://chat.ideaflow.app/api/beeper/write-relay/'+endpoint,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json'},body:encoded,redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs)});};
  try{pending=beforeFetch?beforeFetch(start):start();}finally{open=false;}
  if(!called){void Promise.resolve(pending).catch(()=>{});deny('write_disclosure_denied');}
  let response;try{response=await pending;}catch{deny(signal?.aborted?'write_stopped':'write_transport_unavailable');}
  if(!response.ok)deny(response.status===401||response.status===403?'write_authorization_required':response.status===409?'write_transport_conflict':'write_transport_unavailable',response.status);
  if(!response.headers.get('content-type')?.includes('application/json'))deny('write_transport_invalid');
  const reader=response.body?.getReader();if(!reader)deny('write_transport_invalid');let n=0;const chunks=[];
  try{while(true){const {done,value}=await reader.read();if(done)break;n+=value.byteLength;if(n>256*1024){await reader.cancel();deny('write_transport_invalid');}chunks.push(value);}}catch(e){if(e instanceof BeeperWriteTransportError)throw e;deny('write_transport_unavailable');}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{deny('write_transport_invalid');}
 }
 return Object.freeze({claim:operationId=>post('claim',operationId?{operationId}:{}),receipt:(body,beforeFetch)=>{if(typeof beforeFetch!=='function')deny('write_disclosure_denied');return post('receipt',body,beforeFetch);}});
}
