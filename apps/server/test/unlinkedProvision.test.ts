import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchUnlinkedForIdentity } from '../src/services/unlinkedProvision.js';
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
