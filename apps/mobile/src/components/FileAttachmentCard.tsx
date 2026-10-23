/**
 * FileAttachmentCard — general (non-image, non-audio) file attachment
 * bubble: mime icon, filename, human-readable size, Download (OpenChat-85q.1).
 *
 * Download opens the attachment's URL via Linking, which on web opens/saves
 * it in a new tab and on native hands it to the OS (browser or share sheet).
 */

import React from 'react';
import { Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { AppIcon } from './AppIcon';
import { formatFileSize } from '../utils/fileSize';
import { radius, type } from '../theme/tokens';
import type { Attachment } from '../api/client';

interface Props {
  attachment: Attachment;
  isOwn: boolean;
}

function filenameFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname;
    return decodeURIComponent(path.slice(path.lastIndexOf('/') + 1)) || 'File';
  } catch {
    return 'File';
  }
}

export function FileAttachmentCard({ attachment, isOwn }: Props) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const filename = attachment.filename || filenameFromUrl(attachment.url);
  const size = typeof attachment.sizeBytes === 'number' ? formatFileSize(attachment.sizeBytes) : null;

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: isOwn ? 'rgba(255,255,255,0.18)' : c.surfaceElevated },
      ]}
    >
      <View style={styles.icon}>
        <AppIcon name="file" color={isOwn ? c.bubbleOwnText : c.textSecondary} size={22} />
      </View>
      <View style={styles.info}>
        <Text
          style={[styles.name, { color: isOwn ? c.bubbleOwnText : c.bubbleOtherText }]}
          numberOfLines={1}
        >
          {filename}
        </Text>
        {!!size && (
          <Text style={[styles.size, { color: isOwn ? c.bubbleOwnText : c.textMetadata }]}>
            {size}
          </Text>
        )}
      </View>
      <TouchableOpacity
        onPress={() => void Linking.openURL(attachment.url)}
        style={[styles.downloadBtn, { backgroundColor: isOwn ? 'rgba(255,255,255,0.22)' : c.surface }]}
        accessibilityRole="button"
        accessibilityLabel={`Download ${filename}`}
      >
        <AppIcon name="download" color={isOwn ? c.bubbleOwnText : c.primary} size={16} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radius.md,
    paddingVertical: 8,
    paddingHorizontal: 10,
    marginBottom: 4,
    gap: 8,
  },
  icon: {
    width: 28,
    alignItems: 'center',
  },
  info: {
    flex: 1,
    minWidth: 0,
  },
  name: {
    ...type.label,
  },
  size: {
    ...type.caption,
    marginTop: 1,
  },
  downloadBtn: {
    width: 32,
    height: 32,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
