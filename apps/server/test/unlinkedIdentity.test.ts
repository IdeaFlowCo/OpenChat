import { afterEach, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({run:vi.fn(),close:vi.fn(),search:vi.fn(),configured:vi.fn()}));
vi.mock('../src/db.js',()=>({getDriver:()=>({session:()=>({run:mocks.run,close:mocks.close})})}));
vi.mock('../src/services/unlinkedProvision.js',()=>({unlinkedProvisionConfigured:mocks.configured,searchUnlinkedForIdentity:mocks.search}));
import {toolUnlinkedSearch} from '../src/services/externalActions.js';
afterEach(()=>{vi.clearAllMocks();vi.unstubAllEnvs();});
it('binds Unlinked to database identity for the authenticated caller',async()=>{
 mocks.configured.mockReturnValue(true);
 mocks.run.mockResolvedValue({records:[{get:(key:string)=>({issuer:'https://id.ideaflow.app/api/auth',subject:'alice-sub'}[key])}]});
 mocks.search.mockResolvedValue({code:'grant_revoked'});
 expect(await toolUnlinkedSearch('alice-local','unlinked_search_network',{query:'bank'})).toEqual({code:'grant_revoked'});
 expect(mocks.run.mock.calls[0][1]).toEqual({userId:'alice-local'});
 expect(mocks.search).toHaveBeenCalledWith({issuer:'https://id.ideaflow.app/api/auth',subject:'alice-sub'},'unlinked_search_network','bank',undefined);
 expect(mocks.close).toHaveBeenCalledOnce();
});
it('never substitutes the former owner token when provisioning is missing',async()=>{
 mocks.configured.mockReturnValue(false);vi.stubEnv('OPENCHAT_OWNER_USER_ID','owner');vi.stubEnv('UNLINKED_ACCOUNT_TOKEN','former-owner-secret');
 expect(await toolUnlinkedSearch('owner','unlinked_search_network',{query:'bank'})).toMatchObject({code:'not_configured'});
 expect(mocks.search).not.toHaveBeenCalled();expect(mocks.run).not.toHaveBeenCalled();
});
