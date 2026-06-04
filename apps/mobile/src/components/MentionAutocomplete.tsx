/**
 * MentionAutocomplete — floating dropdown shown above the composer when the
 * user types @<prefix> in a group chat (OpenChat-0jy).
 *
 * Props:
 *   query       — the text after the triggering @, e.g. "ali" for "@ali"
 *   participants — conversation participants to filter against (excludes self)
 *   onSelect    — called with the chosen participant; caller replaces the
 *                 @prefix token with "@Name " in the TextInput
 *   scheme      — color scheme for theming
 */

import React, { useMemo } from 'react';
import {
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Avatar } from './Avatar';
import { colorForUserId } from '../utils/colorForUserId';
import { getColors } from '../theme/colors';
import type { Scheme } from '../utils/colorForUserId';
import type { Participant } from '../api/client';

export interface MentionCandidate {
  userId: string;
  name: string;
  email: string;
  displayName: string;
}

interface Props {
  query: string;
  participants: Participant[];
  onSelect: (candidate: MentionCandidate) => void;
  scheme: Scheme;
}

export function MentionAutocomplete({ query, participants, onSelect, scheme }: Props) {
  const c = getColors(scheme);

  const candidates = useMemo<MentionCandidate[]>(() => {
    const lower = query.toLowerCase();
    return participants
      .map((p): MentionCandidate => ({
        userId: p.user.id,
        name: p.user.name || '',
        email: p.user.email,
        displayName: p.user.name || p.user.email.split('@')[0] || p.user.email,
      }))
      .filter(c =>
        c.displayName.toLowerCase().includes(lower) ||
        c.email.toLowerCase().includes(lower)
      )
      .slice(0, 8); // cap to 8 visible candidates
  }, [query, participants]);

  if (candidates.length === 0) return null;

  return (
    <View style={[styles.container, { backgroundColor: c.surface, borderColor: c.border }]}>
      <FlatList
        data={candidates}
        keyExtractor={item => item.userId}
        keyboardShouldPersistTaps="handled"
        style={styles.list}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={[styles.row, { borderBottomColor: c.divider }]}
            onPress={() => onSelect(item)}
            activeOpacity={0.7}
          >
            <Avatar name={item.displayName} email={item.email} size={28} />
            <View style={styles.textCol}>
              <Text
                style={[styles.name, { color: colorForUserId(item.userId, scheme) }]}
                numberOfLines={1}
              >
                {item.displayName}
              </Text>
              {item.name ? (
                <Text style={[styles.email, { color: c.textMuted }]} numberOfLines={1}>
                  {item.email}
                </Text>
              ) : null}
            </View>
          </TouchableOpacity>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    overflow: 'hidden',
    maxHeight: 240,
  },
  list: {
    flexGrow: 0,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 9,
    gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  textCol: {
    flex: 1,
  },
  name: {
    fontSize: 14,
    fontWeight: '600',
  },
  email: {
    fontSize: 12,
    marginTop: 1,
  },
});
