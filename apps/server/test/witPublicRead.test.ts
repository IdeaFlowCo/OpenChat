import {afterEach,expect,it,vi} from 'vitest';
import {toolWitListIssues} from '../src/services/externalActions.js';
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
it('reads current public WIT data without legacy Supabase or owner credentials',async()=>{
 vi.stubEnv('WIT_ANON_KEY','');vi.stubEnv('WIT_AGENT_KEY','must-not-send');
 const fetch=vi.fn().mockResolvedValue({ok:true,status:200,json:async()=>({issues:[],total_count:0})});vi.stubGlobal('fetch',fetch);
 expect(await toolWitListIssues({})).toEqual({issues:[],total_count:0});
 expect(fetch.mock.calls[0][0]).toMatch(/^https:\/\/api\.worldissuetracker\.com\/functions\/v1\/get-issues/);
 expect(fetch.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
 expect(fetch.mock.calls[0][1].headers).not.toHaveProperty('X-Agent-Key');
 expect(fetch.mock.calls[0][1].headers).not.toHaveProperty('apikey');
});
