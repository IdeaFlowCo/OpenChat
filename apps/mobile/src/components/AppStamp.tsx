import { TouchableOpacity, Text } from 'react-native';
import { useAppStamp } from '../hooks/useAppStamp';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { type } from '../theme/tokens';

export function AppStamp() {
  const { version, label, detail, exact, toggle } = useAppStamp();
  const { scheme } = useTheme();
  const content = <Text style={{ ...type.meta, color: getColors(scheme).textMetadata, fontVariant: ['tabular-nums'], textAlign: 'center' }}>v{version}{label ? ` · ${label}` : ''}</Text>;
  if (!detail) return content;
  return <TouchableOpacity onPress={toggle} accessibilityRole="button" accessibilityLabel={`v${version}${label ? ` · ${label}` : ''}`} accessibilityHint={`Show ${exact ? 'relative' : 'exact'} update time`} style={{ alignSelf: 'center', padding: 8 }}>
    {content}
  </TouchableOpacity>;
}
