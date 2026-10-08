import React,{useState} from 'react';
import {act,create} from 'react-test-renderer';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({create:vi.fn(),resolve:vi.fn(),replace:vi.fn(),params:{source:'unlinked',profile:'https://www.unlinked.ai/people/fixture-profile',askId:'fixture-ask'},user:{userId:'viewer'}}));
vi.mock('react-native',()=>({ActivityIndicator:'ActivityIndicator',ScrollView:'ScrollView',Text:'Text',TouchableOpacity:'TouchableOpacity',View:'View',StyleSheet:{hairlineWidth:1}}));
const navigation={replace:mocks.replace,goBack:vi.fn()};
vi.mock('@react-navigation/native',()=>({useNavigation:()=>navigation,useRoute:()=>({params:mocks.params}),useFocusEffect:(effect:any)=>React.useEffect(effect,[effect])}));
vi.mock('../../mobile/src/contexts/ChatContext',()=>({useChat:()=>({createConversation:mocks.create,currentUser:mocks.user})}));
vi.mock('../../mobile/src/contexts/ThemeContext',()=>({useTheme:()=>({scheme:'light'})}));
vi.mock('../../mobile/src/api/client',()=>({api:{resolveUnlinkedRecipient:mocks.resolve}}));
import {ComposeScreen} from '../../mobile/src/screens/ComposeScreen';
import {ProfileAskBanner,useProfileAskContext} from '../../mobile/src/components/ProfileAskBanner';
import {queueProfileAskContext,setProfileAskAccount,readProfileAskContext} from '../../mobile/src/services/profileAskContext';
import {parseComposeIntent} from '../../mobile/src/utils/composeIntent';
let root:ReturnType<typeof create>|undefined;
const ask={id:'fixture-ask',text:'A controlled test ask',expiresAt:'2099-01-01T00:00:00Z'};
beforeEach(()=>{vi.clearAllMocks();setProfileAskAccount(undefined);(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;mocks.resolve.mockResolvedValue({status:'ready',recipient:{id:'correct-owner'},ask});mocks.create.mockResolvedValue({id:'existing-dm'});});
afterEach(async()=>{await act(async()=>root?.unmount());root=undefined;delete(globalThis as any).IS_REACT_ACT_ENVIRONMENT;});
it('passes only an ask ID, opens the verified owner DM and queues context only for the viewer/thread',async()=>{
 await act(async()=>{root=create(React.createElement(ComposeScreen))});expect(mocks.resolve).toHaveBeenCalledWith(mocks.params.profile,'fixture-ask');expect(mocks.create).toHaveBeenCalledWith(['correct-owner'],{type:'direct'});
 expect(mocks.replace).toHaveBeenCalledWith('Chat',{conversationId:'existing-dm'});expect(readProfileAskContext('wrong-viewer','existing-dm')).toBeNull();expect(readProfileAskContext('viewer','wrong-dm')).toBeNull();expect(readProfileAskContext('viewer','existing-dm')).toEqual(ask);
});
it('an already-mounted copy of the same chat cannot consume context before the visible destination mounts',()=>{
 queueProfileAskContext('viewer','existing-dm',ask);expect(readProfileAskContext('viewer','existing-dm')).toEqual(ask);expect(readProfileAskContext('viewer','existing-dm')).toEqual(ask);
});
it('a revoked ask opens no DM and retains no context',async()=>{
 mocks.resolve.mockResolvedValue({status:'unavailable'});await act(async()=>{root=create(React.createElement(ComposeScreen))});expect(mocks.create).not.toHaveBeenCalled();expect(readProfileAskContext('viewer','existing-dm')).toBeNull();
});
it('shows context without editing a draft; only a labelled action inserts it and account changes clear it',async()=>{
 queueProfileAskContext('viewer','existing-dm',ask);
 function Harness({user='viewer',dm='existing-dm'}:{user?:string;dm?:string}) {const [draft,setDraft]=useState('Existing draft');const[context,dismiss]=useProfileAskContext(user,dm);return React.createElement(React.Fragment,null,React.createElement('span',null,draft),React.createElement(ProfileAskBanner,{ask:context,onDismiss:dismiss,onInsert:(text:string)=>setDraft(value=>value+'\n'+text)}))}
 await act(async()=>{root=create(React.createElement(Harness))});expect(root!.root.findByType('span').props.children).toBe('Existing draft');
 const button=root!.root.findAllByType('TouchableOpacity').find(n=>n.findAllByType('Text').some(t=>t.props.children==='Add ask to draft'))!;
 await act(async()=>button.props.onPress());expect(root!.root.findByType('span').props.children).toBe('Existing draft\nA controlled test ask');expect(root!.root.findAllByType('TouchableOpacity')).toHaveLength(0);
 queueProfileAskContext('viewer','existing-dm',ask);await act(async()=>root!.update(React.createElement(Harness,{user:'another-account'})));expect(root!.root.findAllByType('TouchableOpacity')).toHaveLength(0);expect(readProfileAskContext('viewer','existing-dm')).toBeNull();
});
it('rejects caller-selected bodies/identities, repeated ask IDs, generic ask entry and card/ask conflict',()=>{
 const base='https://chat.ideaflow.app/app/?intent=compose&source=unlinked';const good=base+'&profile='+encodeURIComponent(mocks.params.profile)+'&askId=fixture-ask';expect(parseComposeIntent(new URL(good))?.askId).toBe('fixture-ask');
 for(const suffix of ['&text=secret','&subject=owner','&askId=second'])expect(parseComposeIntent(new URL(good+suffix))).toBeNull();
 expect(parseComposeIntent(new URL(base+'&askId=fixture-ask'))).toBeNull();expect(parseComposeIntent(new URL(good+'&card='+'a'.repeat(24)))).toBeNull();
});
