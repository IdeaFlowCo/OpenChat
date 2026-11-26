import React from 'react';
import {act,create} from 'react-test-renderer';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({get:vi.fn(),enable:vi.fn(),create:vi.fn(),alert:vi.fn()}));
vi.mock('react-native',()=>({ActivityIndicator:'ActivityIndicator',Alert:{alert:mocks.alert},ScrollView:'ScrollView',StyleSheet:{create:(v:unknown)=>v,hairlineWidth:1},Switch:'Switch',Text:'Text',TextInput:'TextInput',TouchableOpacity:'TouchableOpacity',View:'View'}));
vi.mock('@react-navigation/native',()=>({useFocusEffect:(effect:()=>unknown)=>React.useEffect(effect as any,[effect])}));
vi.mock('../../mobile/src/contexts/ThemeContext',()=>({useTheme:()=>({scheme:'light'})}));
vi.mock('../../mobile/src/api/client',()=>({api:{getSecretary:mocks.get,setSecretaryEnabled:mocks.enable,createSecretaryAnswer:mocks.create}}));
vi.mock('../../mobile/src/components/AgentAutoResponses',()=>({AgentAutoResponses:()=>null}));
import {SecretaryScreen} from '../../mobile/src/screens/SecretaryScreen';
let screen:ReturnType<typeof create>;
beforeEach(()=>{vi.resetAllMocks();(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;mocks.get.mockResolvedValue({enabled:false,answers:[]});mocks.enable.mockResolvedValue({enabled:true});});
afterEach(async()=>{await act(async()=>screen?.unmount());delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;});
const mount=async()=>act(async()=>{screen=create(React.createElement(SecretaryScreen));});
it('opening Auto replies loads existing configuration without enabling it or sending an answer',async()=>{
 await mount();expect(mocks.get).toHaveBeenCalledOnce();expect(screen.root.findByType('Switch').props.value).toBe(false);expect(mocks.enable).not.toHaveBeenCalled();expect(mocks.create).not.toHaveBeenCalled();
 const text=screen.root.findAllByType('Text').map(n=>n.props.children).filter(x=>typeof x==='string').join(' ');
 expect(text).toContain('Auto replies');expect(text).toContain('only the exact answers you approve');expect(text).toContain('group chats are never answered');
});
it('changes enabled state only after the owner explicitly operates the switch, restoring on failure',async()=>{
 await mount();mocks.enable.mockRejectedValueOnce(new Error('offline'));
 await act(async()=>{await screen.root.findByType('Switch').props.onValueChange(true);});
 expect(mocks.enable).toHaveBeenCalledExactlyOnceWith(true);expect(screen.root.findByType('Switch').props.value).toBe(false);expect(mocks.alert).toHaveBeenCalled();
});
