// Mac-side importer transport: no origin override, redirects or payload logging.
import {createHash} from 'node:crypto';
export const BEEPER_RELAY_ORIGIN='https://chat.ideaflow.app';
export class BeeperRelayTransportError extends Error{
  constructor(code,status=0,serverCode){super(code);this.code=code;this.status=status;this.serverCode=serverCode;}
}
const fail=(code,status=0,serverCode)=>{throw new BeeperRelayTransportError(code,status,serverCode);};
const safeServerCodes=new Set(['lease_or_sequence_not_current','source_reconciliation_required','source_scope_mismatch','batch_sequence_conflict','batch_digest_mismatch','scan_superseded','scan_not_available','relay_owner_binding_mismatch','connection_revoked_or_expired','invalid_batch']);
async function serverCode(response){
 const reader=response.body?.getReader();if(!reader)return undefined;let size=0;const chunks=[];
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>4096){await reader.cancel();return undefined;}chunks.push(value);}const code=JSON.parse(Buffer.concat(chunks).toString('utf8'))?.error;return safeServerCodes.has(code)?code:undefined;}catch{return undefined;}
}
const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
export function beeperBatchDigest(payload,final){
  const wire=JSON.parse(JSON.stringify({payload,final}));
  return createHash('sha256').update(canonical(wire)).digest('hex');
}
/** Credential callback reads only the locally approved dedicated importer token. */
export function createBeeperRelayTransport({readToken,fetchImpl=fetch,timeoutMs=10000,signal}={}){
  if(typeof readToken!=='function'||!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>30000)fail('relay_configuration_required');
  async function post(endpoint,input,beforeFetch){
    const body=JSON.stringify(input);
    if(Buffer.byteLength(body,'utf8')>1024*1024)fail('relay_request_too_large');
    if(['deliver','catalogue'].includes(endpoint)&&typeof beforeFetch!=='function')fail('relay_disclosure_approval_required');
    const token=await readToken();
    if(typeof token!=='string'||!/^ocbr_[A-Za-z0-9_-]{43}$/.test(token))fail('relay_authorization_required');
    if(signal?.aborted)fail('relay_stopped');
    const deadline=AbortSignal.timeout(timeoutMs),requestSignal=signal?AbortSignal.any([signal,deadline]):deadline;
    let response,dispatched=false,admissionOpen=true;
    const start=()=>{
      if(!admissionOpen||dispatched)fail('relay_disclosure_not_started');
      if(signal?.aborted)fail('relay_stopped');
      dispatched=true;
      try{return Promise.resolve(fetchImpl(`${BEEPER_RELAY_ORIGIN}/api/beeper/relay/${endpoint}`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',Accept:'application/json'},body,redirect:'error',signal:requestSignal})).catch(()=>fail(signal?.aborted?'relay_stopped':'relay_unavailable'));}
      catch(error){if(error instanceof BeeperRelayTransportError)throw error;fail('relay_unavailable');}
    };
    let pending;
    try{pending=beforeFetch?beforeFetch(start):start();}finally{admissionOpen=false;}
    if(!dispatched){void Promise.resolve(pending).catch(()=>{});fail('relay_disclosure_not_started');}
    response=await pending;
    if(!response)fail('relay_invalid_response');
    if(!response.ok){
      const code=await serverCode(response);
      if(response.status===401||response.status===403)fail('relay_authorization_required',response.status,code);
      if(response.status===429)fail('relay_busy',response.status);
      fail(response.status>=500?'relay_unavailable':'relay_rejected',response.status,code);
    }
    if(!response.headers.get('content-type')?.includes('application/json'))fail('relay_invalid_response');
    const reader=response.body?.getReader();if(!reader)fail('relay_invalid_response');
    let size=0;const chunks=[];
    try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>256*1024){await reader.cancel();fail('relay_invalid_response');}chunks.push(value);}}
    catch(error){if(error instanceof BeeperRelayTransportError)throw error;fail('relay_unavailable');}
    try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('relay_invalid_response');}
  }
  return Object.freeze({
    publishCatalogue:(input,beforeFetch)=>post('catalogue',input,beforeFetch),
    claim:async()=>{const result=await post('claim',{});if(!result||!Object.hasOwn(result,'job')||result.job!==null&&(typeof result.job!=='object'||Array.isArray(result.job)))fail('relay_invalid_response');return result;},
    resume:jobId=>post('resume',{jobId}),
    deliver:(input,beforeFetch)=>post('deliver',input,beforeFetch),
    fail:input=>post('fail',input),
  });
}
