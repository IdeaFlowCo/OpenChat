import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
vi.mock('react-native',()=>({Text:'Text',View:'View',StyleSheet:{create:(s:unknown)=>s,hairlineWidth:1}}));
vi.mock('../../mobile/src/contexts/ThemeContext',()=>({useTheme:()=>({scheme:'light'})}));
vi.mock('../../mobile/src/api/socket',()=>({getSocket:()=>null}));
vi.mock('../../mobile/src/api/client',()=>({api:{}}));
import { MessageStatusChips, messageStatusChipLabel } from '../../mobile/src/components/MessageStatusChips';
import { applyMessageStatus, groupMessageStatuses } from '../../mobile/src/hooks/useMessageStatuses';
const entry=(over:Record<string,unknown>)=>({messageId:'m',userId:'ana',userName:'Ana Synthetic',status:'open',visibility:'chat',own:false,...over}) as any;
it('labels chips with Stream status words and who set them',()=>{
 expect(messageStatusChipLabel(entry({}))).toBe('● Open · Ana Synthetic');
 expect(messageStatusChipLabel(entry({status:'closed'}))).toBe('✓ Closed · Ana Synthetic');
 expect(messageStatusChipLabel(entry({own:true}))).toBe('● Open · you');
 expect(messageStatusChipLabel(entry({own:true,visibility:'private'}))).toBe('● Open · only you');
});
it('keeps one status per person per message and removes cleared ones',()=>{
 let map=groupMessageStatuses([entry({}),entry({userId:'ben',userName:'Ben'})]);
 expect(map.m).toHaveLength(2);
 map=applyMessageStatus(map,entry({status:'closed'}));expect(map.m!.filter(s=>s.userId==='ana')).toEqual([expect.objectContaining({status:'closed'})]);
 map=applyMessageStatus(map,entry({status:'none'}));map=applyMessageStatus(map,entry({userId:'ben',status:'none'}));
 expect(map.m).toBeUndefined();
});
it('renders nothing without statuses and an accessible chip per person, own first',()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 let empty!:ReactTestRenderer;act(()=>{empty=create(React.createElement(MessageStatusChips,{statuses:[],isOwn:false}));});expect(empty.toJSON()).toBeNull();
 let tree!:ReactTestRenderer;act(()=>{tree=create(React.createElement(MessageStatusChips,{isOwn:false,statuses:[entry({userId:'ben',userName:'Ben'}),entry({own:true,userId:'me',visibility:'private'})]}));});
 const labels=tree.root.findAll(n=>typeof n.props.accessibilityLabel==='string').map(n=>n.props.accessibilityLabel);
 expect(labels).toEqual(['Status Open, set by you, visible only to you','Status Open, set by Ben']);
});
