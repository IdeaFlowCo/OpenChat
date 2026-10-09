import React from 'react';
import {act,create,type ReactTestRenderer} from 'react-test-renderer';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({list:vi.fn(),threads:vi.fn(),add:vi.fn(),update:vi.fn(),navigate:vi.fn(),dispatch:vi.fn()}));
vi.mock('react-native',()=>({
  View:'View',Text:'Text',TextInput:'TextInput',TouchableOpacity:'TouchableOpacity',ScrollView:'ScrollView',ActivityIndicator:'ActivityIndicator',
  StyleSheet:{create:(x:unknown)=>x},
  Modal:({visible,children}:any)=>visible?children:null,
  FlatList:({data,renderItem,ListEmptyComponent,ListFooterComponent}:any)=>React.createElement('List',{},data.length?data.map((item:any)=>React.createElement(React.Fragment,{key:item.id},renderItem({item}))):ListEmptyComponent,ListFooterComponent),
}));
vi.mock('@react-navigation/native',()=>({useNavigation:()=>({navigate:mocks.navigate,dispatch:mocks.dispatch}),CommonActions:{navigate:(x:unknown)=>x},useFocusEffect:(fn:any)=>React.useEffect(fn,[fn])}));
vi.mock('../../mobile/src/contexts/ThemeContext',()=>({useTheme:()=>({scheme:'light'})}));
vi.mock('../../mobile/src/theme/breakpoints',()=>({useIsDesktop:()=>false}));
vi.mock('../../mobile/src/api/client',()=>({OPENCHAT_URL:'https://example.test',api:{getMessageCaptures:mocks.list,getCaptureThreads:mocks.threads,addMessageCapture:mocks.add,updateMessageCapture:mocks.update}}));
import {SavedMessagesScreen} from '../../mobile/src/screens/SavedMessagesScreen';
let tree:ReactTestRenderer;
const entry={id:'capture',threadId:'dad',threadTitle:'Dad',channel:'imessage',text:'Saved article',sourceAt:'2026-10-01T00:00:00Z',tags:['longevity'],destination:'stream',pinned:false};
const press=async(label:string)=>{const b=tree.root.findAllByType('TouchableOpacity').find(n=>n.findAllByType('Text').some(t=>t.children.join('')===label));if(!b)throw new Error('Missing button: '+label);await act(async()=>b.props.onPress());};
beforeEach(()=>{vi.clearAllMocks();mocks.list.mockResolvedValue({items:[entry]});mocks.threads.mockResolvedValue({threads:[{id:'dad',title:'Dad',channel:'imessage',count:1,participants:['dad@example.test'],contactDetails:[{label:'Email',value:'dad@example.test'}]}]});mocks.add.mockResolvedValue({id:'new',threadId:'dad'});mocks.update.mockResolvedValue({updated:true});});
afterEach(async()=>{if(tree)await act(async()=>tree.unmount());});
it('provides persistent search and direct Add, writes without requiring a source message',async()=>{
  await act(async()=>{tree=create(React.createElement(SavedMessagesScreen));});
  expect(tree.root.findByProps({accessibilityLabel:'Search saved messages'})).toBeTruthy();
  await press('＋ Add');
  await act(async()=>tree.root.findByProps({accessibilityLabel:'New note or link'}).props.onChangeText('A new idea #longevity'));
  await press('Add');
  expect(mocks.add).toHaveBeenCalledWith({text:'A new idea #longevity',threadId:undefined,destination:'stream',contactLabel:undefined,tags:['longevity'],pinned:false});
});
it('opens contact details by clicking the person, shows Apple fields, and scopes Add',async()=>{
  await act(async()=>{tree=create(React.createElement(SavedMessagesScreen));});
  await act(async()=>tree.root.findByProps({accessibilityLabel:'Open details for Dad'}).props.onPress());
  expect(mocks.list).toHaveBeenLastCalledWith({threadId:'dad',search:'',destination:'contact'});
  expect(tree.root.findAllByType('Text').some(t=>t.children.join('')==='From Apple Contacts')).toBe(true);
  await press('＋ Add');
  await act(async()=>{tree.root.findByProps({accessibilityLabel:'Contact field name'}).props.onChangeText('Mailing address');tree.root.findByProps({accessibilityLabel:'Contact detail value'}).props.onChangeText('42 Example Lane');});
  await press('Add');
  expect(mocks.add).toHaveBeenCalledWith(expect.objectContaining({threadId:'dad',destination:'contact',contactLabel:'Mailing address',text:'42 Example Lane',pinned:false}));
});
it('pins privately without publishing or changing the contact destination',async()=>{
  await act(async()=>{tree=create(React.createElement(SavedMessagesScreen));});await press('Pin');
  expect(mocks.update).toHaveBeenCalledWith('capture',{pinned:true});
});

it.each([
  ['SSN','dummy-identifier'], ['Passport number','dummy-identifier'],
  ['Bank account','dummy-identifier'], ['Confidential','ordinary words'],
])('keeps the %s contact draft unsent',async(label,value)=>{
  await act(async()=>{tree=create(React.createElement(SavedMessagesScreen));});
  await act(async()=>tree.root.findByProps({accessibilityLabel:'Open details for Dad'}).props.onPress());
  await press('＋ Add');
  await act(async()=>{
    tree.root.findByProps({accessibilityLabel:'Contact field name'}).props.onChangeText(label);
    tree.root.findByProps({accessibilityLabel:'Contact detail value'}).props.onChangeText(value);
  });
  mocks.list.mockClear();mocks.threads.mockClear();
  await press('Add');
  expect(mocks.add).not.toHaveBeenCalled();
  expect(mocks.list).not.toHaveBeenCalled();
  expect(mocks.threads).not.toHaveBeenCalled();
  expect(tree.root.findByProps({accessibilityLabel:'Contact detail value'}).props.value).toBe(value);
  expect(tree.root.findAllByProps({accessibilityRole:'alert'}).some(n=>n.children.join('').includes('Store it locally'))).toBe(true);
});
it.each(['Ordinary words #ＣＯＮＦＩＤＥＮＴＩＡＬ','Example SSN: 123-45-6789','4111 1111 1111 1111','passport:dummy-id'])('keeps identifier-like or confidential notes unsent',async(value)=>{
  await act(async()=>{tree=create(React.createElement(SavedMessagesScreen));});
  await press('＋ Add');
  await act(async()=>tree.root.findByProps({accessibilityLabel:'New note or link'}).props.onChangeText(value));
  await press('Add');
  expect(mocks.add).not.toHaveBeenCalled();
  expect(tree.root.findByProps({accessibilityLabel:'New note or link'}).props.value).toBe(value);
});
