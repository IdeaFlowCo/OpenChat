import { StyleSheet, Text, TouchableOpacity } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { roles, space, touchTarget, type } from '../theme/tokens';
import type { NavProp } from '../navigation/types';

/** A visible noun even when the desktop sidebar is collapsed. */
export function CommunitiesLink({ compact = false }: { compact?: boolean }) {
  const navigation = useNavigation<NavProp<'Communities'>>();
  const { scheme } = useTheme();
  const r = roles(getColors(scheme));
  return <TouchableOpacity accessibilityRole="button" accessibilityLabel="Communities"
    onPress={() => navigation.navigate('Communities')} style={[styles.link, compact && styles.compact]}>
    <Text style={[compact ? type.caption : type.label, { color: r.accent, textAlign: compact ? 'center' : 'left' }]}>Communities</Text>
  </TouchableOpacity>;
}

const styles = StyleSheet.create({
  link: { minHeight: touchTarget, justifyContent: 'center', paddingHorizontal: space[4], paddingVertical: space[2] },
  compact: { paddingHorizontal: space[1] },
});
