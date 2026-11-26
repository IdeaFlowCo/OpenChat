import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({get:vi.fn(),set:vi.fn()}));
vi.mock('react-native',()=>({ActivityIndicator:'ActivityIndicator',Text:'Text',View:'View'}));
vi.mock('../../mobile/src/contexts/ThemeContext',()=>({useTheme:()=>({scheme:'light'})}));
vi.mock('../../mobile/src/api/client',()=>({api:{getMessageStatus:mocks.get,setMessageStatus:mocks.set}}));
vi.mock('../../mobile/src/components/ui',()=>({Button:(props:unknown)=>React.createElement('Button',props)}));
import { MessageStatusControls } from '../../mobile/src/components/MessageStatusControls';
let screen:ReturnType<typeof create>;
beforeEach(()=>{vi.resetAllMocks();(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;mocks.get.mockResolvedValue({status:'none'});mocks.set.mockImplementation(async(_id,status)=>({status}));});
afterEach(async()=>{await act(async()=>screen?.unmount());delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;});
const mount=async(id='synthetic-message')=>act(async()=>{screen=create(React.createElement(MessageStatusControls,{messageId:id}));});
const button=(label:string)=>screen.root.findAllByType('Button').find(b=>b.props.label===label)!;
it('reads current status, saves via the source-bound API and shows only confirmed success',async()=>{
 await mount();expect(mocks.get).toHaveBeenCalledWith('synthetic-message');expect(mocks.set).not.toHaveBeenCalled();
 await act(async()=>{await button('Open').props.onPress();});
 expect(mocks.set).toHaveBeenCalledWith('synthetic-message','open');
 expect(button('✓ Open')).toBeDefined();expect(screen.root.findByProps({accessibilityLiveRegion:'polite'}).props.children).toContain('Status saved');
});
it('reports a possibly committed response failure honestly and permits idempotent retry',async()=>{
 await mount();mocks.set.mockRejectedValueOnce(new Error('response lost'));
 await act(async()=>{await button('Open').props.onPress();});
 expect(screen.root.findByProps({accessibilityRole:'alert'}).props.children).toContain('Could not confirm status');
 expect(screen.root.findAllByProps({accessibilityLiveRegion:'polite'})).toHaveLength(0);
 await act(async()=>{await button('Open').props.onPress();});expect(mocks.set).toHaveBeenCalledTimes(2);
});
it('shows a retry for failed status reads and does not allow a blind write',async()=>{
 mocks.get.mockRejectedValueOnce(new Error('offline'));await mount();expect(button('Retry')).toBeDefined();expect(button('Open')).toBeUndefined();expect(mocks.set).not.toHaveBeenCalled();
 await act(async()=>button('Retry').props.onPress());expect(button('Open')).toBeDefined();
});
it('does not let an old message load or save overwrite a new message’s status',async()=>{
 let resolve!: (value:unknown)=>void;mocks.get.mockReturnValueOnce(new Promise(r=>{resolve=r;}));await mount('a');
 await act(async()=>{screen.update(React.createElement(MessageStatusControls,{messageId:'b'}));});
 await act(async()=>resolve({status:'closed'}));expect(button('✓ No status')).toBeDefined();
 let finish!: (value:unknown)=>void;mocks.set.mockReturnValueOnce(new Promise(r=>{finish=r;}));
 await act(async()=>{void button('Open').props.onPress();});
 await act(async()=>{screen.update(React.createElement(MessageStatusControls,{messageId:'c'}));});
 await act(async()=>finish({status:'open'}));expect(button('✓ No status')).toBeDefined();
});
