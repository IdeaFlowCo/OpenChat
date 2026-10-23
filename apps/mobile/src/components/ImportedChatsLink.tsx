/**
 * Front door to imported chats (OpenChat-061g), on the Chats list. Shown only
 * once the owner has an imported chat, so nobody else sees an empty door.
 */
import { useCallback, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { api } from '../api/client';
import { useImportedRoles } from './ImportedChatParts';
import { Chip, ListRow } from './ui';
import { space, type } from '../theme/tokens';
import type { NavProp } from '../navigation/types';

export function ImportedChatsLink({ variant = 'row' }: { variant?: 'row' | 'link' | 'compact' }) {
  const navigation = useNavigation<NavProp<'ImportedChats'>>();
  const r = useImportedRoles();
  const [count, setCount] = useState(0);
  useFocusEffect(useCallback(() => {
    let active = true;
    api.listImportedChats().then(({ chats }) => { if (active) setCount(chats.length); }).catch(() => {});
    return () => { active = false; };
  }, []));
  if (!count) return null;
  const open = () => navigation.navigate('ImportedChats');
  if (variant === 'row') {
    return <ListRow icon="download" title="Imported chats" onPress={open} accessibilityLabel={`Imported chats, ${count}`}
      trailing={<Chip label={String(count)} />} style={[styles.row, { borderBottomColor: r.line }]} />;
  }
  const compact = variant === 'compact';
  return (
    <TouchableOpacity accessibilityRole="button" accessibilityLabel="Imported chats" onPress={open} style={[styles.link, compact && styles.compact]}>
      <Text style={[compact ? type.caption : type.label, styles.linkText, { color: r.accent, textAlign: compact ? 'center' : 'left' }]}>Imported chats</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  row: { borderBottomWidth: StyleSheet.hairlineWidth },
  link: { minHeight: 44, justifyContent: 'center', paddingVertical: space[2], paddingHorizontal: space[4] },
  compact: { width: '100%', paddingHorizontal: space[1] },
  linkText: { fontWeight: '600' },
});
