import {afterEach,expect,it,vi} from 'vitest';
vi.mock('@react-native-async-storage/async-storage',()=>({default:{getItem:async()=>null,setItem:async()=>{},removeItem:async()=>{}}}));
vi.mock('expo-secure-store',()=>({getItemAsync:async()=>null,setItemAsync:async()=>{},deleteItemAsync:async()=>{}}));
import {api,setSession,onAuthExpired,clearSession} from '../../mobile/src/api/client';
import {setAuthenticatedRequestGuard} from '../../mobile/src/api/authenticatedRequest';
afterEach(async()=>{vi.unstubAllGlobals();await clearSession();});
const operations=[
 ['listCommunities',()=>api.listCommunities()],
 ['getCommunity',()=>api.getCommunity('community')],
 ['createCommunity',()=>api.createCommunity('Synthetic','')],
 ['updateCommunity',()=>api.updateCommunity('community','Synthetic','')],
 ['joinCommunity',()=>api.joinCommunity('synthetic-code')],
 ['createCommunityGroup',()=>api.createCommunityGroup('community','Synthetic')],
 ['linkCommunityGroup',()=>api.linkCommunityGroup('community','group')],
 ['unlinkCommunityGroup',()=>api.unlinkCommunityGroup('community','group')],
 ['joinCommunityGroup',()=>api.joinCommunityGroup('community','group')],
 ['setCommunityMemberRole',()=>api.setCommunityMemberRole('community','member','admin')],
 ['removeCommunityMember',()=>api.removeCommunityMember('community','member')],
 ['createCommunityInvite',()=>api.createCommunityInvite('community')],
 ['revokeCommunityInvites',()=>api.revokeCommunityInvites('community')],
 ['unpinThought',()=>api.unpinThought('own-note','announcement')],
 ['deleteThought',()=>api.deleteThought('own-note')],
 ['updateThought',()=>api.updateThought('own-pinned-note',{text:'Synthetic edit'})],
 ['pinThought',()=>api.pinThought('own-note','announcement','Synthetic reviewed text')],
 ['createThought',()=>api.createThought({text:'Synthetic',pinToConversationId:'announcement'})],
 ['editMessage',()=>api.editMessage('own-announcement','Synthetic edit')],
 ['deleteMessage',()=>api.deleteMessage('own-announcement')],
 ['forwardMessage',()=>api.forwardMessage('source-message','announcement')],
 ['addReaction',()=>api.addReaction('announcement','👍')],
 ['removeReaction',()=>api.removeReaction('announcement','👍')],
 ['getMessageStatus',()=>api.getMessageStatus('announcement')],
 ['setMessageStatus',()=>api.setMessageStatus('announcement','open','chat')],
] as const;
it.each(operations)('keeps a valid session after a current membership/role refusal from %s',async(_name,operation)=>{
 await setSession('synthetic-token',{userId:'synthetic-owner',email:'synthetic@example.test'});
 const restore=setAuthenticatedRequestGuard(async()=>true),expired=vi.fn(),off=onAuthExpired(expired);
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({error:'Current permission required'}),{status:403,headers:{'content-type':'application/json'}})));
 try{await expect(operation()).rejects.toMatchObject({status:403});expect(expired).not.toHaveBeenCalled();}finally{restore();off();}
});
it('still expires the session for actual401 authentication failures',async()=>{
 await setSession('synthetic-token',{userId:'synthetic-owner',email:'synthetic@example.test'});
 const restore=setAuthenticatedRequestGuard(async()=>true),expired=vi.fn(),off=onAuthExpired(expired);
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({error:'Session expired'}),{status:401,headers:{'content-type':'application/json'}})));
 try{await expect(api.updateThought('own-note',{text:'Synthetic'})).rejects.toMatchObject({status:401});expect(expired).toHaveBeenCalledTimes(1);}finally{restore();off();}
});
