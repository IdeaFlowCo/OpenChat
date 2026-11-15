import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({desktop:true,nav:{setOptions:vi.fn(),canGoBack:()=>true,goBack:vi.fn(),navigate:vi.fn()}}));
vi.mock('react-native',()=>({Text:'Text',View:'View',TouchableOpacity:'TouchableOpacity'}));
vi.mock('@react-navigation/native',()=>({useNavigation:()=>mocks.nav}));
vi.mock('../../mobile/src/theme/breakpoints',()=>({useIsDesktop:()=>mocks.desktop}));
vi.mock('../../mobile/src/contexts/ThemeContext',()=>({useTheme:()=>({scheme:'light'})}));
vi.mock('../../mobile/src/components/MasterDetailLayout',()=>({MasterDetailLayout:({detail}:any)=>React.createElement('SidebarAndDetail',null,detail)}));
import { DesktopDetailScreen } from '../../mobile/src/components/DesktopDetailScreen';
let tree:ReactTestRenderer;
afterEach(async()=>{if(tree)await act(async()=>tree.unmount());vi.clearAllMocks();});
it('retains sidebar, title and usable Back on desktop secondary screens',async()=>{
 mocks.desktop=true;await act(async()=>{tree=create(React.createElement(DesktopDetailScreen,{title:'Settings',children:React.createElement('Content')}));});
 expect(tree.root.findAllByType('SidebarAndDetail' as any)).toHaveLength(1);expect(mocks.nav.setOptions).toHaveBeenCalledWith({headerShown:false});
 await act(async()=>tree.root.findByProps({accessibilityLabel:'Back'}).props.onPress());expect(mocks.nav.goBack).toHaveBeenCalled();
});
it('keeps the native stack and original screen on phone widths',async()=>{
 mocks.desktop=false;await act(async()=>{tree=create(React.createElement(DesktopDetailScreen,{title:'Profile',children:React.createElement('Content')}));});
 expect(tree.root.findAllByType('SidebarAndDetail' as any)).toHaveLength(0);expect(tree.root.findAllByType('Content' as any)).toHaveLength(1);expect(mocks.nav.setOptions).toHaveBeenCalledWith({headerShown:true});
});
