import {expect,it,vi} from 'vitest';
import {createBeeperRelayTransport,beeperBatchDigest} from '../../../scripts/beeper-client/relayTransport.mjs';
import {beeperPayloadDigest} from '../src/services/beeperRelay.js';
const token='ocbr_'+'A'.repeat(43),reply=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
it('uses only literal importer endpoints and rejects login/provider credentials before network',async()=>{
 const fetch=vi.fn(async()=>reply({job:null})),transport=createBeeperRelayTransport({readToken:async()=>token,fetchImpl:fetch});
 await transport.claim();expect(fetch).toHaveBeenCalledWith('https://chat.ideaflow.app/api/beeper/relay/claim',expect.objectContaining({method:'POST',redirect:'error',headers:expect.objectContaining({Authorization:'Bearer '+token})}));
 await expect(createBeeperRelayTransport({readToken:async()=> 'ordinary-session-token',fetchImpl:fetch}).claim()).rejects.toMatchObject({code:'relay_authorization_required'});expect(fetch).toHaveBeenCalledTimes(1);
});
it('maps provider errors without private response text or redirect following',async()=>{
 for(const [status,code] of [[401,'relay_authorization_required'],[403,'relay_authorization_required'],[429,'relay_busy'],[503,'relay_unavailable'],[302,'relay_rejected']] as const){
  const fetch=vi.fn(async()=>reply({error:'private-body-canary'},status));
  const error=await createBeeperRelayTransport({readToken:async()=>token,fetchImpl:fetch}).claim().catch(e=>e);
  expect(error).toMatchObject({code,status});expect(String(error)).not.toContain('canary');expect(fetch).toHaveBeenCalledTimes(1);expect(fetch.mock.calls[0]![0]).toBe('https://chat.ideaflow.app/api/beeper/relay/claim');
 }
});
it('bounds uploads before reading a credential and streams before JSON parsing',async()=>{
 const readToken=vi.fn(async()=>token),fetch=vi.fn(async()=>reply({huge:'x'.repeat(262144)})),transport=createBeeperRelayTransport({readToken,fetchImpl:fetch});
 await expect(transport.deliver({huge:'x'.repeat(1048576)})).rejects.toMatchObject({code:'relay_request_too_large'});expect(readToken).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
 await expect(transport.claim()).rejects.toMatchObject({code:'relay_invalid_response'});
});
it('does not disclose after local stop during the credential callback',async()=>{
 const stop=new AbortController();let done!:(value:string)=>void;const fetch=vi.fn();const transport=createBeeperRelayTransport({readToken:()=>new Promise(r=>{done=r;}),fetchImpl:fetch,signal:stop.signal});
 const call=transport.claim();stop.abort();done(token);await expect(call).rejects.toMatchObject({code:'relay_stopped'});expect(fetch).not.toHaveBeenCalled();
});
it('matches the server digest of the exact wire payload and final state',()=>{
 const payload={source:{accountKey:'synthetic',chatKey:'source'},messages:[{text:'Synthetic text',optional:undefined}],coverage:{complete:false}};
 const wire=JSON.parse(JSON.stringify(payload));expect(beeperBatchDigest(payload,true)).toBe(beeperPayloadDigest({payload:wire,final:true}));expect(beeperBatchDigest(payload,false)).not.toBe(beeperBatchDigest(payload,true));
});

it('requires a local disclosure fence and rechecks it after the asynchronous token read',async()=>{
 let done!:(value:string)=>void,revoked=false;const fetch=vi.fn(async()=>reply({sequence:0,chatId:'synthetic'}));
 const transport=createBeeperRelayTransport({readToken:()=>new Promise(resolve=>{done=resolve;}),fetchImpl:fetch});
 await expect(transport.publishCatalogue({items:[],complete:false})).rejects.toMatchObject({code:'relay_disclosure_approval_required'});expect(fetch).not.toHaveBeenCalled();
 const call=transport.deliver({payload:'synthetic'},start=>{if(revoked)throw Object.assign(new Error('Local grant revoked'),{code:'local_approval_required'});return start();});
 revoked=true;done(token);await expect(call).rejects.toMatchObject({code:'local_approval_required'});expect(fetch).not.toHaveBeenCalled();
});
it('starts each guarded upload synchronously exactly once and refuses a deferred dispatch',async()=>{
 const fetch=vi.fn(async()=>reply({sequence:0,chatId:'synthetic'}));const transport=createBeeperRelayTransport({readToken:async()=>token,fetchImpl:fetch});
 await transport.deliver({payload:'synthetic'},start=>start());expect(fetch).toHaveBeenCalledTimes(1);
 await expect(transport.deliver({payload:'synthetic'},async start=>{await Promise.resolve();return start();})).rejects.toMatchObject({code:'relay_disclosure_not_started'});expect(fetch).toHaveBeenCalledTimes(1);
});
