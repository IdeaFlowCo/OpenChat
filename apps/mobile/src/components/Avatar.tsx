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
import { AppIcon } from './AppIcon';

export interface GroupAvatarMember {
  avatarUrl?: string | null;
}

interface Props {
  name?: string;
  email?: string;
  isBot?: boolean;
  /** Pass a presence status to render the bottom-right dot. Hide by omitting. */
  presenceStatus?: PresenceStatus;
  size?: number;
  /** If set, renders the photo instead of initials. (OpenChat-x2s) */
  avatarUrl?: string;
  /** Group avatars cluster 2–4 member photos, or use a people glyph. */
  variant?: 'person' | 'group';
  groupMembers?: GroupAvatarMember[];
}

function initials(name?: string, email?: string): string {
  const seed = (name || email?.split('@')[0] || '?').trim();
  const parts = seed.split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return seed.slice(0, 2).toUpperCase();
}

function GroupGlyph({ size, color }: { size: number; color: string }) {
  return <AppIcon name="people" color={color} size={size * 0.62} strokeWidth={1.8} />;
}

function GroupPhotoCluster({ urls, size, borderColor }: { urls: string[]; size: number; borderColor: string }) {
  const count = Math.min(urls.length, 4);
  const diameter = size * (count === 2 ? 0.7 : count === 3 ? 0.62 : 0.56);
  const edge = size - diameter;
  const positions = count === 2
    ? [{ left: 0, top: 0 }, { left: edge, top: edge }]
    : count === 3
      ? [
          { left: edge / 2, top: 0 },
          { left: 0, top: edge },
          { left: edge, top: edge },
        ]
      : [
          { left: 0, top: 0 },
          { left: edge, top: 0 },
          { left: 0, top: edge },
          { left: edge, top: edge },
        ];

  return (
    <View style={StyleSheet.absoluteFill}>
      {urls.slice(0, count).map((url, index) => (
        <Image
          key={`${url}-${index}`}
          source={{ uri: url }}
          accessible={false}
          style={{
            position: 'absolute',
            ...positions[index],
            width: diameter,
            height: diameter,
            borderRadius: diameter / 2,
            borderWidth: Math.max(1, Math.round(size * 0.035)),
            borderColor,
            zIndex: index + 1,
          }}
        />
      ))}
    </View>
  );
}

export function Avatar({
  name,
  email,
  isBot,
  presenceStatus,
  size = 44,
  avatarUrl,
  variant = 'person',
  groupMembers = [],
}: Props) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const dotSize = Math.max(8, Math.round(size / 4));
  const groupPhotoUrls = groupMembers
    .map(member => member.avatarUrl)
    .filter((url): url is string => !!url)
    .slice(0, 4);
  const showGroupCluster = variant === 'group' && groupPhotoUrls.length >= 2;
  return (
    <View
      style={{ width: size, height: size }}
      accessible={variant === 'group' || !!isBot}
      accessibilityLabel={variant === 'group' ? 'Group avatar' : isBot ? 'AI participant avatar' : undefined}
    >
      <View
        style={[
          styles.bubble,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: c.surfaceElevated,
            overflow: 'hidden',
          },
        ]}
      >
        {showGroupCluster ? (
          <GroupPhotoCluster urls={groupPhotoUrls} size={size} borderColor={c.background} />
        ) : variant === 'group' ? (
          <GroupGlyph size={size} color={c.textSecondary} />
        ) : avatarUrl ? (
          <Image
            source={{ uri: avatarUrl }}
            style={{ width: size, height: size, borderRadius: size / 2 }}
          />
        ) : (
          isBot ? (
            <AppIcon name="bot" color={c.textMetadata} size={Math.round(size * 0.52)} />
          ) : (
            <Text
              style={{
                color: c.textSecondary,
                fontWeight: '600',
                fontSize: Math.round(size * 0.4),
              }}
            >
              {initials(name, email)}
            </Text>
          )
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
