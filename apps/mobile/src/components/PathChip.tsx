/**
 * A file location on someone's own computer. A browser cannot open it from a
 * web page, so it is never a link: pressing it copies the path, and the notice
 * says where to paste it. The full path is the tooltip and the screen-reader label.
 */
import React from 'react';
import { Platform, Text } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { showNotice } from '../services/notice';
import { radius, type } from '../theme/tokens';

const mono = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'ui-monospace, SFMono-Regular, Menlo, monospace' });
export const PATH_COPIED = 'Path copied: paste in Finder (⇧⌘G)';

export async function copyLocalPath(path: string): Promise<void> {
  try {
    const copied = await Clipboard.setStringAsync(path);
    showNotice(copied === false ? 'Could not copy the path' : PATH_COPIED);
  } catch { showNotice('Could not copy the path'); }
}

export function PathChip({ label, path, color, background, onLongPress }: {
  label: string; path: string; color: string; background: string; onLongPress?: () => void;
}) {
  // A bare path is its own label and reads best in monospace; a named link keeps the body face.
  const named = label !== path;
  const chip = <Text accessibilityRole="button" accessibilityLabel={`Copy file path: ${path}`}
    accessibilityHint="Copies the path. It is a location on a computer, not a web link."
    onPress={event => { event?.stopPropagation?.(); void copyLocalPath(path); }} onLongPress={onLongPress}
    style={[{ color, backgroundColor: background, borderRadius: radius.sm, textDecorationLine: 'underline', textDecorationStyle: 'dotted' },
      !named && { fontFamily: mono, fontSize: type.label.fontSize }]}>
    {'📁 '}{label}
  </Text>;
  // react-native-web's Text drops `title`, so the tooltip rides on a plain span.
  return Platform.OS === 'web' ? React.createElement('span', { title: path }, chip) : chip;
}
