/**
 * The one header for everything in a chat's Stream: Back channel posts and
 * Stream entries alike. Who wrote it and when on the first line; who can read
 * it on the second. The audience is the loudest label on the card because it
 * is the thing a reader most needs to get right: "Shared with this chat" and
 * "Private · Only you" must never look alike.
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

export function AudienceChip({ audience }: { audience: StreamAudience }) {
  const r = roles(getColors(useTheme().scheme));
  const isPrivate = audience === 'private';
  const color = isPrivate ? r.onAccentSoft : r.textMeta;
  return <View style={[styles.chip, isPrivate && { backgroundColor: r.accentSoft, paddingHorizontal: space[2] }]}>
    <AppIcon name={isPrivate ? 'lock' : 'people'} color={color} size={12} />
    <Text style={[type.meta, isPrivate && styles.strong, { color }]}>{isPrivate ? 'Private · Only you' : 'Shared with this chat'}</Text>
  </View>;
}

export function StreamCardHeader({ name, avatarName, avatarUrl, agentName, createdAt, edited, audience, kind, onShowExactTime, trailing }: {
  name: string;
  /** The author's real name for the avatar when `name` is shown as "You". */
  avatarName?: string; avatarUrl?: string;
  /** Set when an agent wrote this on the author's behalf. */
  agentName?: string;
  createdAt: string; edited?: boolean; audience: StreamAudience;
  /** What it is, in a word or two: Note, Ask, Offer, From a message, Pinned. */
  kind?: string;
  /** Tap on the time, for people who cannot hover. */
  onShowExactTime?: (exact: string) => void;
  trailing?: React.ReactNode;
}) {
  const c = getColors(useTheme().scheme);
  const [hovered, setHovered] = useState(false);
  const exact = new Date(createdAt).toLocaleString();
  return <View style={styles.header}>
    <View style={styles.who}>
      <Avatar name={agentName || avatarName || name} avatarUrl={agentName ? undefined : avatarUrl} isBot={!!agentName} size={24} />
      <Text numberOfLines={1} style={[type.label, styles.name, { color: c.textPrimary }]}>{name}</Text>
      {agentName ? <Text numberOfLines={1} style={[type.meta, styles.agent, { color: c.textMetadata }]}>via {agentName} · Agent</Text> : null}
      <View style={styles.spacer} />
      {/* Without a handler the time is plain text: a button that does nothing is worse than none. */}
      {onShowExactTime ? <View style={{ zIndex: hovered ? 1 : 0 }}>
        <Pressable accessibilityRole="button" accessibilityLabel={`Show exact time: ${exact}`} hitSlop={14}
          onPress={() => onShowExactTime(exact)}
          onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)}
          onFocus={() => setHovered(true)} onBlur={() => setHovered(false)}
          style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
          <Text style={[type.meta, { color: c.textMetadata }]}>{formatRelativeTime(createdAt)}{edited ? ' · Edited' : ''}</Text>
        </Pressable>
        {hovered && <View pointerEvents="none" style={[styles.tooltip, { backgroundColor: c.background, borderColor: c.border }]}>
          <Text role="tooltip" numberOfLines={1} style={[type.meta, { color: c.textPrimary }]}>{exact}</Text>
        </View>}
      </View> : <Text accessibilityLabel={exact} style={[type.meta, { color: c.textMetadata }]}>{formatRelativeTime(createdAt)}</Text>}
      {trailing}
    </View>
    <View style={styles.audience}>
      <AudienceChip audience={audience} />
      {kind ? <Text style={[type.meta, { color: c.textMetadata }]}>· {kind}</Text> : null}
    </View>
  </View>;
}

const styles = StyleSheet.create({
  header: { gap: space[2] },
  who: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  name: { fontWeight: '600', flexShrink: 1 },
  agent: { flexShrink: 2 },
  spacer: { flex: 1, minWidth: space[1] },
  audience: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space[2] },
  chip: { flexDirection: 'row', alignItems: 'center', gap: space[1], minHeight: 22, borderRadius: radius.pill },
  strong: { fontWeight: '600' },
  tooltip: { position: 'absolute', top: 22, right: 0, padding: space[2], borderRadius: radius.sm, borderWidth: StyleSheet.hairlineWidth },
});
