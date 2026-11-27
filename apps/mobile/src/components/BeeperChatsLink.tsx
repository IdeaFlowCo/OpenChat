import { Text, TouchableOpacity } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { roles, space, touchTarget, type } from '../theme/tokens';
import { ListRow } from './ui';
import type { NavProp } from '../navigation/types';

export function BeeperChatsLink({ compact }: { compact?: boolean }) {
  const navigation = useNavigation<NavProp<'BeeperChats'>>();
  const r = roles(getColors(useTheme().scheme));
  const open = () => navigation.navigate('BeeperChats');
  if (compact === undefined) return <ListRow icon="download" title="Beeper chats" subtitle="Read-only" onPress={open} />;
  return <TouchableOpacity accessibilityRole="button" onPress={open} accessibilityLabel="Beeper chats"
    style={{ minHeight: touchTarget, justifyContent: 'center', paddingHorizontal: compact ? space[1] : space[4] }}>
    <Text style={[compact ? type.caption : type.label, { color: r.accent, textAlign: compact ? 'center' : 'left' }]}>Beeper chats</Text>
  </TouchableOpacity>;
}
