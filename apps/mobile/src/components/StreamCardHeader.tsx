/**
 * The one header for everything in a chat's Stream: Back channel posts and
 * Stream entries alike. One line: who wrote it, when, who can read it, what it
 * is, and (as a link on that label) the message it came from. The scope is always spelled out ("Only you",
 * "Shared with Sam") because it is the thing a reader most needs to get right.
 */
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { radius, roles, space, type } from '../theme/tokens';
import { formatRelativeTime } from '../utils/relativeTime';
import { AppIcon } from './AppIcon';
import { Avatar } from './Avatar';

export type StreamAudience = 'private' | 'shared';

/** `sharedScope` comes from the conversation's membership (utils/streamScope.ts). */
export function AudienceChip({ audience, sharedScope = 'Shared with this chat' }: { audience: StreamAudience; sharedScope?: string }) {
  const r = roles(getColors(useTheme().scheme));
  const isPrivate = audience === 'private';
  const color = isPrivate ? r.onAccentSoft : r.textMeta;
  const label = isPrivate ? 'Only you' : sharedScope;
  return <View accessible accessibilityLabel={`Privacy scope: ${label}`} style={[styles.chip, isPrivate && { backgroundColor: r.accentSoft, paddingHorizontal: space[2] }]}>
    <AppIcon name={isPrivate ? 'lock' : 'people'} color={color} size={12} />
    <Text numberOfLines={1} style={[type.meta, isPrivate && styles.strong, { color }]}>{label}</Text>
  </View>;
}

export function StreamCardHeader({ name, avatarName, avatarUrl, agentName, createdAt, edited, audience, sharedScope, kind, onShowExactTime, onOpenSource, trailing }: {
  name: string;
  /** The author's real name for the avatar when `name` is shown as "You". */
  avatarName?: string; avatarUrl?: string;
  /** Set when an agent wrote this on the author's behalf. */
  agentName?: string;
  createdAt: string; edited?: boolean; audience: StreamAudience; sharedScope?: string;
  /** What it is, in a word or two: Note, Ask, Offer, From a message, Pinned. */
  kind?: string;
  /** Tap on the time, for people who cannot hover. */
  onShowExactTime?: (exact: string) => void;
  /** Opens the chat message this was saved from. */
  onOpenSource?: () => void;
  trailing?: React.ReactNode;
}) {
  const c = getColors(useTheme().scheme);
  const [hovered, setHovered] = useState(false);
  const exact = new Date(createdAt).toLocaleString();
  const meta = [type.meta, { color: c.textMetadata }];
  return <View style={styles.header}>
    <View style={styles.line}>
      <Avatar name={agentName || avatarName || name} avatarUrl={agentName ? undefined : avatarUrl} isBot={!!agentName} size={18} />
      <Text numberOfLines={1} style={[type.label, styles.name, { color: c.textPrimary }]}>{name}</Text>
      {agentName ? <Text numberOfLines={1} style={[meta, styles.agent]}>via {agentName} · Agent</Text> : null}
      {/* Without a handler the time is plain text: a button that does nothing is worse than none. */}
      {onShowExactTime ? <View style={{ zIndex: hovered ? 1 : 0 }}>
        <Pressable accessibilityRole="button" accessibilityLabel={`Show exact time: ${exact}`} hitSlop={14}
          onPress={() => onShowExactTime(exact)}
          onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)}
          onFocus={() => setHovered(true)} onBlur={() => setHovered(false)}
          style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
          <Text style={meta}>{formatRelativeTime(createdAt)}{edited ? ' · Edited' : ''}</Text>
        </Pressable>
        {hovered && <View pointerEvents="none" style={[styles.tooltip, { backgroundColor: c.background, borderColor: c.border }]}>
          <Text role="tooltip" numberOfLines={1} style={[type.meta, { color: c.textPrimary }]}>{exact}</Text>
        </View>}
      </View> : <Text accessibilityLabel={exact} style={meta}>{formatRelativeTime(createdAt)}</Text>}
      <AudienceChip audience={audience} sharedScope={sharedScope} />
      {/* What it is. When it was saved from a chat message, that label is the way back to the message. */}
      {onOpenSource ? <Pressable accessibilityRole="link" accessibilityLabel="Original message" hitSlop={14} onPress={onOpenSource}
        style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}><Text style={[type.meta, styles.source, { color: c.primary }]}>{kind || 'Original message'}</Text></Pressable>
        : kind ? <Text style={meta}>{kind}</Text> : null}
    </View>
    {trailing ? <View style={styles.trailing}>{trailing}</View> : null}
  </View>;
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: space[2] },
  // One line where it fits; on a narrow phone it wraps instead of truncating the scope.
  line: { flex: 1, minWidth: 0, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: space[2] + 2, rowGap: 2 },
  trailing: { flexDirection: 'row', alignItems: 'center', gap: space[1], minHeight: 20 },
  name: { fontWeight: '600', flexShrink: 1 },
  agent: { flexShrink: 1 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: space[1], minHeight: 18, borderRadius: radius.pill },
  strong: { fontWeight: '600' },
  source: { fontWeight: '500' },
  tooltip: { position: 'absolute', top: 20, left: 0, padding: space[2], borderRadius: radius.sm, borderWidth: StyleSheet.hairlineWidth },
});
