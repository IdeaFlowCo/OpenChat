import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ list: vi.fn(), save: vi.fn() }));
vi.mock('react-native', () => ({ View: 'View', Text: 'Text', TouchableOpacity: 'TouchableOpacity', ActivityIndicator: 'ActivityIndicator', Linking: { openURL: vi.fn() }, FlatList: ({data,renderItem,ListEmptyComponent,ListFooterComponent}: any) => React.createElement('List', {}, data.length ? data.map((item:any) => React.createElement(React.Fragment,{key:item.id},renderItem({item}))) : ListEmptyComponent,ListFooterComponent) }));
vi.mock('../../mobile/src/contexts/ThemeContext', () => ({ useTheme: () => ({ scheme: 'light' }) }));
vi.mock('../../mobile/src/services/streamDisplay', () => ({ useStreamCompact: () => [true] }));
vi.mock('../../mobile/src/api/client', () => ({ api: { listConversationResources: mocks.list, setConversationResourceSaved: mocks.save } }));
import { ConversationResources } from '../../mobile/src/components/ConversationResources';
const row = { id:'a',title:'Synthetic paper',url:'https://example.com',host:'example.com',kind:'paper',tags:[],sources:['iMessage'],saved:false };
let tree: ReactTestRenderer;
const press = async (text:string) => { const button = tree.root.findAllByType('TouchableOpacity' as any).find(n => n.findAllByType('Text' as any).some(t => t.children.join('') === text))!; await act(async()=>button.props.onPress()); };
beforeEach(()=> {vi.clearAllMocks();mocks.list.mockResolvedValue({enabled:true,resources:[row],nextCursor:'next',pending:0,indexingPending:false});});
afterEach(async()=>{if(tree) await act(async()=>tree.unmount());});
it('keeps member links paginated with source labels and saves through the resource API',async()=>{
 await act(async()=>{tree=create(React.createElement(ConversationResources, { conversationId: 'room', search: '' }));});
 expect(JSON.stringify(tree.toJSON())).toContain('iMessage');
 mocks.list.mockResolvedValueOnce({enabled:true,resources:[{...row,id:'b',title:'Second paper'}],nextCursor:null,pending:0});await press('Load more links');expect(mocks.list).toHaveBeenLastCalledWith('room','next');
 mocks.save.mockResolvedValue({resource:{...row,saved:true}});await press('Save');expect(mocks.save).toHaveBeenCalledWith('room','a',true);
});
it('removes loaded member material when authorization is denied',async()=>{
 await act(async()=>{tree=create(React.createElement(ConversationResources, { conversationId: 'room', search: '' }));});
 mocks.list.mockRejectedValueOnce(Object.assign(new Error('Membership denied'),{status:403}));
 // Refresh uses the same authorization boundary as initial and paginated reads.
 const list=tree.root.findByType(ConversationResources).findAll(n=>typeof n.props.onRefresh==='function')[0];
 await act(async()=>list.props.onRefresh());
 expect(JSON.stringify(tree.toJSON())).not.toContain('Synthetic paper');
});
