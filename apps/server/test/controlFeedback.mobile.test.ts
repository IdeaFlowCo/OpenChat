import React from 'react';
import {act,create,type ReactTestRenderer} from 'react-test-renderer';
import {afterEach,expect,it,vi} from 'vitest';
vi.mock('react-native',()=>({StyleSheet:{create:(x:any)=>x,hairlineWidth:1},View:'View',Text:'Text',TouchableOpacity:'TouchableOpacity',ActivityIndicator:'ActivityIndicator'}));
vi.mock('../../mobile/src/contexts/ThemeContext',()=>({useTheme:()=>({scheme:'light'})}));
vi.mock('../../mobile/src/components/AppIcon',()=>({AppIcon:()=>null}));
import {Button} from '../../mobile/src/components/ui/Button';
let tree:ReactTestRenderer;
afterEach(async()=>{if(tree)await act(async()=>tree.unmount());vi.unstubAllGlobals();});
it('retains native pressed feedback when hover and focus are unavailable',async()=>{
 await act(async()=>{tree=create(React.createElement(Button,{label:'Save'}));});
 expect(tree.root.findByType('TouchableOpacity' as any).props.activeOpacity).toBe(0.7);
});
it('uses instant mouse feedback on web while preserving the keyboard focus path',async()=>{
 vi.stubGlobal('document',{});await act(async()=>{tree=create(React.createElement(Button,{label:'Save'}));});
 const button=()=>tree.root.findByType('TouchableOpacity' as any);const before=JSON.stringify(button().props.style);
 expect(button().props.activeOpacity).toBe(1);await act(async()=>button().props.onFocus());expect(JSON.stringify(button().props.style)).not.toBe(before);
});
