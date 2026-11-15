import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { useNavigation } from '@react-navigation/native';
import { Text, TouchableOpacity, View } from 'react-native';
import { useIsDesktop } from '../theme/breakpoints';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { space, type } from '../theme/tokens';
import type { NavProp } from '../navigation/types';
import { MasterDetailLayout } from './MasterDetailLayout';

/** Secondary screens retain the chat sidebar on desktop; phone keeps its stack. */
export function DesktopDetailScreen({ title, children }: { title: string; children: ReactNode }) {
  const heading = useRef<{ focus?: () => void } | null>(null);
  const desktop = useIsDesktop();
  const navigation = useNavigation<NavProp<'Conversations'>>();
  const c = getColors(useTheme().scheme);
  useLayoutEffect(() => { navigation.setOptions({ headerShown: !desktop }); if (desktop) heading.current?.focus?.(); }, [desktop, navigation]);
  if (!desktop) return <>{children}</>;
  return <MasterDetailLayout detail={<View style={{ flex: 1 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3], paddingHorizontal: space[4], minHeight: 56, borderBottomWidth: 1, borderColor: c.border }}>
      <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back" onPress={() => { if (navigation.canGoBack()) navigation.goBack(); else navigation.navigate('Conversations'); }} style={{ minHeight: 44, justifyContent: 'center' }}><Text style={[type.label, { color: c.primary }]}>Back</Text></TouchableOpacity>
      <Text accessibilityRole="header" {...{ tabIndex: -1 }} ref={node => { heading.current = node as unknown as { focus?: () => void }; }} style={[type.title, { color: c.textPrimary }]}>{title}</Text>
    </View>
    {children}
  </View>} />;
}
