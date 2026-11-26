import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ params: { messageId: 'old-message' } as {messageId:string}|{thoughtId:string}, verified: true, userId: 'synthetic-owner', rendered: [] as {ownerId:string;verified:boolean;target:string;text:unknown}[], get: vi.fn(), thought: vi.fn(), dispatch: vi.fn() }));
vi.mock('react-native', () => ({ ActivityIndicator:'ActivityIndicator',ScrollView:'ScrollView',Text:'Text',TouchableOpacity:'TouchableOpacity',View:'View' }));
vi.mock('@react-navigation/native', () => ({ useRoute:()=>({params:mocks.params}),CommonActions:{navigate:(value:unknown)=>value} }));
vi.mock('../../mobile/src/services/notifications', () => ({ navigationRef:{dispatch:mocks.dispatch} }));
vi.mock('../../mobile/src/contexts/ThemeContext', () => ({ useTheme:()=>({scheme:'light'}) }));
vi.mock('../../mobile/src/contexts/ChatContext', () => ({ useChat:()=>({isIdentityVerified:mocks.verified,currentUser:{userId:mocks.userId}}) }));
vi.mock('../../mobile/src/components/MessageText', () => ({MessageText:(props:any)=>{
 mocks.rendered.push({ownerId:mocks.userId,verified:mocks.verified,target:'messageId' in mocks.params?mocks.params.messageId:mocks.params.thoughtId,text:props.content});
 return React.createElement('MessageText',props);
}}));
vi.mock('../../mobile/src/api/client', () => ({api:{getMessageContext:mocks.get,getThoughtContext:mocks.thought}}));
import { OriginalMessageScreen } from '../../mobile/src/screens/OriginalMessageScreen';
let screen:ReturnType<typeof create>;
const context = (id='old-message') => ({conversation:{id:'synthetic-chat',name:'Synthetic chat',type:'group'},messageId:id,messages:[{id:'before',content:'Earlier long message '.repeat(500),createdAt:'2020-01-01'}, {id,content:'Exact target',createdAt:'2020-01-01'},{id:'after',content:'Later message',createdAt:'2020-01-01'}]});
beforeEach(()=>{vi.clearAllMocks();mocks.params={messageId:'old-message'};mocks.verified=true;mocks.userId='synthetic-owner';mocks.rendered=[];mocks.get.mockResolvedValue(context());(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;});
afterEach(async()=>{await act(async()=>screen?.unmount());delete(globalThis as any).IS_REACT_ACT_ENVIRONMENT;});
const mount=()=>act(async()=>{screen=create(React.createElement(OriginalMessageScreen));});
it('puts the exact linked message first without earlier long messages hiding it; context is explicitly expandable',async()=>{
 await mount();expect(mocks.get).toHaveBeenCalledWith('old-message');
 expect(screen.root.findAllByType('MessageText').map(n=>n.props.content)).toEqual(['Exact target']);
 const button=screen.root.findAllByType('TouchableOpacity').find(n=>n.findAllByType('Text').some(t=>t.props.children==='Show surrounding messages'))!;
 await act(async()=>button.props.onPress());
 expect(screen.root.findAllByType('MessageText').map(n=>n.props.content)).toEqual(context().messages.map(m=>m.content));
});
it('ignores a slow old request after another linked message is opened',async()=>{
 let resolve!:(value:unknown)=>void;mocks.get.mockReturnValueOnce(new Promise(r=>{resolve=r;}));await mount();
 mocks.params={messageId:'new-message'};mocks.get.mockResolvedValueOnce(context('new-message'));
 await act(async()=>screen.update(React.createElement(OriginalMessageScreen)));
 await act(async()=>resolve({...context(),messages:[{id:'old-message',content:'Wrong previous target',createdAt:'2020-01-01'}]}));
 expect(screen.root.findAllByType('MessageText').map(n=>n.props.content)).toEqual(['Exact target']);
});
it('shows an unavailable message rather than stale source content after an access failure',async()=>{
 mocks.get.mockRejectedValueOnce(new Error('Synthetic access failure'));await mount();
 expect(screen.root.findAllByType('MessageText')).toHaveLength(0);
 expect(screen.root.findByProps({accessibilityRole:'alert'}).props.children).toContain('Message unavailable');
});
it('waits for restored-account verification before requesting a linked message',async()=>{
 mocks.verified=false;await mount();
 expect(mocks.get).not.toHaveBeenCalled();
 expect(screen.root.findAllByType('MessageText')).toHaveLength(0);
 mocks.verified=true;await act(async()=>screen.update(React.createElement(OriginalMessageScreen)));
 expect(mocks.get).toHaveBeenCalledOnce();
 expect(screen.root.findAllByType('MessageText').map(n=>n.props.content)).toEqual(['Exact target']);
});
it('clears the old owner content while the next account is unverified and ignores its late request',async()=>{
 let resolve!:(value:unknown)=>void;mocks.get.mockReturnValueOnce(new Promise(r=>{resolve=r;}));await mount();
 mocks.verified=false;mocks.userId='different-owner';
 await act(async()=>screen.update(React.createElement(OriginalMessageScreen)));
 await act(async()=>resolve(context()));
 expect(screen.root.findAllByType('MessageText')).toHaveLength(0);
 expect(mocks.get).toHaveBeenCalledOnce();
 mocks.verified=true;mocks.get.mockResolvedValueOnce({...context(),messages:[{id:'old-message',content:'New owner authorized context',createdAt:'2020-01-01'}]});
 await act(async()=>screen.update(React.createElement(OriginalMessageScreen)));
 expect(screen.root.findAllByType('MessageText').map(n=>n.props.content)).toEqual(['New owner authorized context']);
});
it.each(['owner','target','verification'] as const)('does not render old content during the %s transition, before passive cleanup',async transition=>{
 await mount();expect(screen.root.findAllByType('MessageText')).toHaveLength(1);
 mocks.rendered=[];mocks.get.mockReturnValueOnce(new Promise(()=>{}));
 if(transition==='owner')mocks.userId='different-owner';
 if(transition==='target')mocks.params={messageId:'different-message'};
 if(transition==='verification')mocks.verified=false;
 await act(async()=>screen.update(React.createElement(OriginalMessageScreen)));
 // This records each actual MessageText render, including renders preceding
 // useEffect cleanup; checking only screen.root after act would miss a flash.
 expect(mocks.rendered).toEqual([]);
});
