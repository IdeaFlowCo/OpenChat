import React from 'react';
import {act,create} from 'react-test-renderer';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({ask:vi.fn(),dismiss:vi.fn()}));
vi.mock('expo-clipboard',()=>({setStringAsync:vi.fn()}));
vi.mock('react-native',()=>({Alert:{alert:vi.fn()},Clipboard:{setString:vi.fn()},Platform:{OS:'ios'},StyleSheet:{create:(v:unknown)=>v,hairlineWidth:1},Modal:'Modal',Pressable:'Pressable',ScrollView:'ScrollView',Text:'Text',TextInput:'TextInput',TouchableOpacity:'TouchableOpacity',View:'View'}));
vi.mock('../../mobile/src/contexts/ThemeContext',()=>({useTheme:()=>({scheme:'light'})}));
vi.mock('../../mobile/src/components/MessageStatusControls',()=>({MessageStatusControls:(props:unknown)=>React.createElement('MessageStatusControls',props)}));
vi.mock('../../mobile/src/components/ReactionPicker',()=>({ReactionPicker:()=>null}));
vi.mock('../../mobile/src/components/AppIcon',()=>({AppIcon:()=>null}));
vi.mock('../../mobile/src/components/MessageLinkActions',()=>({MessageLinkActions:()=>null}));
import {MessageActionSheet} from '../../mobile/src/components/MessageActionSheet';
let screen:ReturnType<typeof create>;
const message={id:'synthetic-id',conversationId:'synthetic-chat',senderId:'synthetic-sender',content:'Synthetic request',createdAt:'2026-01-01',attachments:[]};
beforeEach(()=>{vi.resetAllMocks();(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;});
afterEach(async()=>{await act(async()=>screen?.unmount());delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;});
const mount=async()=>act(async()=>{screen=create(React.createElement(MessageActionSheet,{visible:true,message,isOwn:false,senderName:'Synthetic',onDismiss:mocks.dismiss,onReply:vi.fn(),onForward:vi.fn(),onForwardToAssistant:vi.fn(),onAskAssistant:mocks.ask,onSaveToThoughts:vi.fn(),onEdit:vi.fn(),onDelete:vi.fn(),onReact:vi.fn(),onBlock:vi.fn(),onReport:vi.fn()} as any));});
const button=(label:string)=>screen.root.findAllByType('TouchableOpacity').find(b=>b.findAllByType('Text').some(t=>t.props.children===label))!;
it('offers a one-action private built-in-agent response without prompting for another question',async()=>{
 await mount();expect(mocks.ask).not.toHaveBeenCalled();await act(async()=>button('Get agent reply now').props.onPress());
 expect(mocks.ask).toHaveBeenCalledExactlyOnceWith(message,expect.stringContaining('do not send it to the source chat'));expect(mocks.dismiss).toHaveBeenCalledOnce();
});
it('opens the status controls for the exact selected message without replying or sharing',async()=>{
 await mount();await act(async()=>button('Set status…').props.onPress());expect(screen.root.findByType('MessageStatusControls').props.messageId).toBe(message.id);expect(mocks.ask).not.toHaveBeenCalled();
});
