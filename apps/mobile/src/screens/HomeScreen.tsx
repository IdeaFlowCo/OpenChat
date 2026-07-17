import { useLayoutEffect } from 'react';
import { useNavigation } from '@react-navigation/native';
import { useIsDesktop } from '../theme/breakpoints';
import { ConversationsScreen } from './ConversationsScreen';
import { MasterDetailLayout } from '../components/MasterDetailLayout';
import type { NavProp } from '../navigation/types';

export function HomeScreen() {
  const isDesktop = useIsDesktop();
  const navigation = useNavigation<NavProp<'Conversations'>>();

  useLayoutEffect(() => {
    navigation.setOptions({ headerShown: !isDesktop });
  }, [isDesktop, navigation]);

  return isDesktop ? <MasterDetailLayout /> : <ConversationsScreen />;
}
