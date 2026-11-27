/** Async storage is an authorization boundary too: validate the captured session
 * after every await, with no asynchronous gap between the last check and commit. */
export async function publishCurrentConversationSnapshot<T>(
  store:{isActive():Promise<boolean>},
  load:()=>Promise<T>,
  isCurrent:()=>boolean,
  commit:(data:T)=>void,
):Promise<boolean>{
  if(!isCurrent()||!await store.isActive()||!isCurrent())return false;
  const data=await load();
  const active=await store.isActive();
  if(!active||!isCurrent())return false;
  commit(data);return true;
}
