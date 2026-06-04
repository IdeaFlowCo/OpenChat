/**
 * Avatar circle. Shows a photo (avatarUrl), initials, or 🤖 for bots,
 * with an optional presence dot in the bottom-right.
 *
 * avatarUrl support added in OpenChat-x2s.
 */
import { Image, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { PresenceDot, PresenceStatus } from './PresenceDot';
import { getColors } from '../theme/colors';

interface Props {
  name?: string;
  email?: string;
  isBot?: boolean;
  /** Pass a presence status to render the bottom-right dot. Hide by omitting. */
  presenceStatus?: PresenceStatus;
  size?: number;
  /** If set, renders the photo instead of initials. (OpenChat-x2s) */
  avatarUrl?: string;
}

function initials(name?: string, email?: string): string {
  const seed = (name || email?.split('@')[0] || '?').trim();
  const parts = seed.split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return seed.slice(0, 2).toUpperCase();
}

export function Avatar({ name, email, isBot, presenceStatus, size = 44, avatarUrl }: Props) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const dotSize = Math.max(8, Math.round(size / 4));
  return (
    <View style={{ width: size, height: size }}>
      <View
        style={[
          styles.bubble,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: isBot ? 'rgba(168, 85, 247, 0.18)' : c.surfaceElevated,
            overflow: 'hidden',
          },
        ]}
      >
        {avatarUrl ? (
          <Image
            source={{ uri: avatarUrl }}
            style={{ width: size, height: size, borderRadius: size / 2 }}
          />
        ) : (
          <Text
            style={{
              color: isBot ? '#7e22ce' : c.textSecondary,
              fontWeight: '600',
              fontSize: Math.round(size * 0.4),
            }}
          >
            {isBot ? '🤖' : initials(name, email)}
          </Text>
        )}
      </View>
      {presenceStatus && (
        <View style={[styles.dotWrap, { width: dotSize + 4, height: dotSize + 4 }]}>
          <PresenceDot status={presenceStatus} size={dotSize} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bubble: { alignItems: 'center', justifyContent: 'center' },
  dotWrap: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
