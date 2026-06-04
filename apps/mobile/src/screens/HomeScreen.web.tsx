/**
 * HomeScreen — WEB responsive variant (OpenChat-601).
 *
 * Mounted at the "Conversations" route key in the ChatsNavigator stack.
 * Renders the side-by-side master/detail layout at desktop widths
 * (>= 900 px) and falls back to the mobile single-column list otherwise.
 *
 * Why one route instead of two: the stack navigator has a single home
 * slot. Keeping the route name as "Conversations" means existing call
 * sites (navigation.popToTop(), replace('Chat', …)) continue to work
 * without churn.
 *
 * The native-stack header is hidden in desktop mode because
 * MasterDetailLayout renders its own sidebar header inside the sidebar.
 * In narrow mode the header is configured by ConversationsScreen via
 * setOptions.
 */

import { useLayoutEffect } from 'react';
import { useNavigation } from '@react-navigation/native';
import { useIsDesktop } from '../theme/breakpoints';
import { ConversationsScreen } from './ConversationsScreen';
import { MasterDetailLayout } from '../components/MasterDetailLayout.web';
import type { NavProp } from '../navigation/types';

export function HomeScreen() {
  const isDesktop = useIsDesktop();
  const navigation = useNavigation<NavProp<'Conversations'>>();

  // Hide / show the native-stack header per width. Run as a layout effect
  // so a window resize never leaves a stale header behind.
  useLayoutEffect(() => {
    navigation.setOptions({ headerShown: !isDesktop });
  }, [isDesktop, navigation]);

  return isDesktop ? <MasterDetailLayout /> : <ConversationsScreen />;
}
