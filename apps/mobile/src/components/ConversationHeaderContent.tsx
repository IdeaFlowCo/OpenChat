import type { ReactNode } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { serif } from '../theme/typography';
import { Avatar, type GroupAvatarMember } from './Avatar';

interface ConversationHeaderContentProps {
  title: string;
  subtitle: string;
  avatarName: string;
  avatarEmail?: string;
  avatarUrl?: string;
  isBot?: boolean;
  variant: 'person' | 'group';
  groupMembers?: GroupAvatarMember[];
  avatarSize?: number;
  minHeight?: number;
  onPress?: () => void;
  action?: ReactNode;
}

/** Shared, width-bounded identity/action composition for every chat header. */
export function ConversationHeaderContent({
  title,
  subtitle,
  avatarName,
  avatarEmail,
  avatarUrl,
  isBot,
  variant,
  groupMembers,
  avatarSize = 28,
  minHeight = 44,
  onPress,
  action,
}: ConversationHeaderContentProps) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const accessibleTitle = title || 'Chat';
  const accessibleStatus = subtitle ? `. ${subtitle}` : '';

  return (
    <View style={[styles.root, { minHeight }]}>
      <TouchableOpacity
        onPress={onPress}
        disabled={!onPress}
        activeOpacity={0.7}
        accessibilityRole={onPress ? 'button' : undefined}
        accessibilityLabel={`Conversation information for ${accessibleTitle}${accessibleStatus}`}
        style={styles.identity}
      >
        <Avatar
          name={avatarName}
          email={avatarEmail}
          isBot={isBot}
          avatarUrl={avatarUrl}
          variant={variant}
          groupMembers={groupMembers}
          size={avatarSize}
        />
        <View style={styles.copy}>
          <Text
            numberOfLines={1}
            ellipsizeMode="tail"
            style={[styles.title, { color: c.textPrimary }]}
          >
            {accessibleTitle}
          </Text>
          {!!subtitle && (
            <Text
              numberOfLines={1}
              ellipsizeMode="tail"
              style={[styles.subtitle, { color: c.textMetadata }]}
            >
              {subtitle}
            </Text>
          )}
        </View>
      </TouchableOpacity>
      {!!action && <View style={styles.actions}>{action}</View>}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
  },
  identity: {
    flex: 1,
    minWidth: 0,
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  copy: { flex: 1, minWidth: 0 },
  title: {
    flexShrink: 1,
    fontFamily: serif,
    fontSize: 17,
    lineHeight: 22,
    fontWeight: '600',
  },
  subtitle: { fontSize: 12, lineHeight: 16 },
  actions: { flexShrink: 0, flexDirection: 'row', alignItems: 'center' },
});
