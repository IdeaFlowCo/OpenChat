import React from 'react';
import { Text, TouchableOpacity } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import type { NavProp } from '../navigation/types';

export function ContextReviewLink({ compact = false }: { compact?: boolean }) {
  const navigation = useNavigation<NavProp<'ContextReview'>>();
  const { scheme } = useTheme();
  const c = getColors(scheme);
  return <TouchableOpacity accessibilityRole="button" accessibilityLabel="Agent drafts" onPress={() => navigation.navigate('ContextReview')} style={{ minHeight: 44, ...(compact ? { width: '100%' as const } : {}), paddingVertical: 10, paddingHorizontal: compact ? 4 : 16, justifyContent: 'center' }}>
    <Text style={{ color: c.primary, fontSize: compact ? 12 : 14, fontWeight: '600', textAlign: compact ? 'center' : 'left' }}>Agent drafts</Text>
  </TouchableOpacity>;
}
