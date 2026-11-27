import {describe,expect,it,vi} from 'vitest';
import {publishCurrentConversationSnapshot} from '../../mobile/src/services/conversationRefresh';
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};};
describe('community conversation refresh across async storage boundaries',()=>{
  it('never restores a revoked permission if invalidation arrives during the final storage probe',async()=>{
    const lastProbe=deferred<boolean>(),entered=deferred<void>();let revision=1,permission=false;
    const store={isActive:vi.fn().mockResolvedValueOnce(true).mockImplementationOnce(()=>{entered.resolve();return lastProbe.promise;})};
    const task=publishCurrentConversationSnapshot(store,async()=>({canPost:true}),()=>revision===1,data=>{permission=data.canPost;});
    await entered.promise;revision++;permission=false;lastProbe.resolve(true);
    expect(await task).toBe(false);expect(permission).toBe(false);
  });
  it('does not fetch for a session invalidated during its first storage probe',async()=>{
    const probe=deferred<boolean>();let current=true;const load=vi.fn(async()=>({canPost:true})),commit=vi.fn();
    const task=publishCurrentConversationSnapshot({isActive:()=>probe.promise},load,()=>current,commit);
    current=false;probe.resolve(true);expect(await task).toBe(false);expect(load).not.toHaveBeenCalled();expect(commit).not.toHaveBeenCalled();
  });
  it('commits an active current session and rejects account/store replacement while data loads',async()=>{
    const commit=vi.fn();expect(await publishCurrentConversationSnapshot({isActive:async()=>true},async()=>['current'],()=>true,commit)).toBe(true);expect(commit).toHaveBeenCalledWith(['current']);
    const response=deferred<string[]>(),loaded=deferred<void>();let sameStore=true;
    const stale=publishCurrentConversationSnapshot({isActive:async()=>true},()=>{loaded.resolve();return response.promise;},()=>sameStore,commit);
    await loaded.promise;sameStore=false;response.resolve(['old owner']);expect(await stale).toBe(false);expect(commit).toHaveBeenCalledTimes(1);
  });
});
