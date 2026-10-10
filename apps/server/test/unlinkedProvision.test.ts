import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lookupUnlinkedContactForIdentity, lookupUnlinkedContactsByHash, searchUnlinkedForIdentity } from '../src/services/unlinkedProvision.js';
const identity = {issuer:'https://id.ideaflow.app/api/auth',subject:'alice'};
const fetchMock = vi.fn();
beforeEach(()=>{vi.stubGlobal('fetch',fetchMock);fetchMock.mockReset();vi.stubEnv('UNLINKED_PROVISION_CLIENT_ID','openchat');vi.stubEnv('UNLINKED_PROVISION_CLIENT_SECRET','private-service-secret');});
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
describe('per-user Unlinked grants',()=>{
 it('provisions exact verified identity and uses only the returned token',async()=>{
  fetchMock.mockResolvedValueOnce({ok:true,json:async()=>({accessToken:'alice-token'})}).mockResolvedValueOnce({ok:true,json:async()=>({results:[]})});
  await searchUnlinkedForIdentity(identity,'unlinked_search_network','bank',2);
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(identity);
  expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer alice-token');
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({query:'bank',degree:2});
  expect(fetchMock.mock.calls.every(c=>c[1].redirect==='error')).toBe(true);
 });
 it('does not search or fall back after explicit revocation',async()=>{
  fetchMock.mockResolvedValue({ok:false,json:async()=>({error:{code:'grant_revoked',message:'secret'}})});
  expect(await searchUnlinkedForIdentity(identity,'unlinked_search_network','bank')).toMatchObject({code:'grant_revoked'});
  expect(fetchMock).toHaveBeenCalledTimes(1);
 });
 it('rejects absent/wrong identity and incomplete provisioning config',async()=>{
  expect(await searchUnlinkedForIdentity(null,'unlinked_search_network','bank')).toMatchObject({code:'not_linked'});
  expect(await searchUnlinkedForIdentity({...identity,issuer:'https://other.test'},'unlinked_search_network','bank')).toMatchObject({code:'not_linked'});
  vi.stubEnv('UNLINKED_PROVISION_CLIENT_SECRET','');
  expect(await searchUnlinkedForIdentity(identity,'unlinked_search_network','bank')).toMatchObject({code:'not_configured'});
  expect(fetchMock).not.toHaveBeenCalled();
 });
 it('cancelling provisioning prevents the subsequent search',async()=>{
  const controller=new AbortController();
  fetchMock.mockImplementationOnce(async()=>{controller.abort();return {ok:true,json:async()=>({accessToken:'alice-token'})};});
  await searchUnlinkedForIdentity(identity,'unlinked_search_network','bank',undefined,controller.signal);
  expect(fetchMock).toHaveBeenCalledTimes(1);
 });
 it('never returns provider errors or credentials',async()=>{
  fetchMock.mockRejectedValue(Error('private-service-secret'));
  expect(JSON.stringify(await searchUnlinkedForIdentity(identity,'unlinked_search_network','bank'))).not.toContain('private-service-secret');
 });
});
describe('owner-scoped Unlinked contact lookup (unlinked-9kk.3)',()=>{
 const hash='a'.repeat(64);
 it('asks contacts/lookup with the owner grant and keeps only the contact fields',async()=>{
  fetchMock.mockResolvedValueOnce({ok:true,json:async()=>({accessToken:'alice-token'})}).mockResolvedValueOnce({ok:true,json:async()=>({kind:'unlinked_lookup_contact',visibility:'owner_private',contact:{connectionId:'c'.repeat(64),name:' Ada Lovelace ',headline:'Engineer',linkedinRefHash:hash,publishedProfileId:null,provenance:{type:'owner_import'},extra:'dropped'}})});
  const result=await lookupUnlinkedContactForIdentity(identity,{connectionId:'c'.repeat(64)});
  expect(result).toEqual({ok:true,contact:{connectionId:'c'.repeat(64),name:'Ada Lovelace',headline:'Engineer',linkedinRefHash:hash,publishedProfileId:null}});
  expect(fetchMock.mock.calls[1][0]).toBe('https://www.unlinked.ai/api/agent/v1/contacts/lookup');
  expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer alice-token');
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({connectionId:'c'.repeat(64)});
 });
 it('maps not_found and invalid input to not_found, revocation to grant_revoked, anything else to upstream_unavailable',async()=>{
  for(const [code,expected] of [['not_found','not_found'],['invalid_input','not_found'],['grant_revoked','grant_revoked'],['rate_limited','upstream_unavailable']]){
   fetchMock.mockReset().mockResolvedValueOnce({ok:true,json:async()=>({accessToken:'t'})}).mockResolvedValueOnce({ok:false,json:async()=>({error:{code}})});
   expect(await lookupUnlinkedContactForIdentity(identity,{linkedinUrl:'linkedin.com/in/ada'})).toEqual({ok:false,code:expected});
  }
  expect(await lookupUnlinkedContactForIdentity(null,{profileId:'p'})).toEqual({ok:false,code:'not_linked'});
 });
 it('a contact with nothing to key it by is not found; malformed hashes are never sent',async()=>{
  fetchMock.mockResolvedValueOnce({ok:true,json:async()=>({accessToken:'t'})}).mockResolvedValueOnce({ok:true,json:async()=>({contact:{name:'Nobody',linkedinRefHash:'not-a-hash'}})});
  expect(await lookupUnlinkedContactForIdentity(identity,{profileId:'p'})).toEqual({ok:false,code:'not_found'});
  fetchMock.mockReset();
  expect(await lookupUnlinkedContactsByHash(identity,['nope'])).toEqual({ok:true,contacts:[]});
  expect(fetchMock).not.toHaveBeenCalled();
  fetchMock.mockResolvedValueOnce({ok:true,json:async()=>({accessToken:'t'})}).mockResolvedValueOnce({ok:true,json:async()=>({contacts:[{connectionId:'x1',name:'Ada',linkedinRefHash:hash,publishedProfileId:'pub-1'}]})});
  expect(await lookupUnlinkedContactsByHash(identity,[hash,hash,'bad'])).toEqual({ok:true,contacts:[{connectionId:'x1',name:'Ada',linkedinRefHash:hash,publishedProfileId:'pub-1'}]});
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({refHashes:[hash]});
 });
});
