/**
 * LinkPreviewCard — renders an Open Graph preview card below a message bubble.
 * (OpenChat-hq2)
 *
 * Layout: thumbnail image on the left, title (bold) + description (2-line
 * truncate) + small siteName on the right. Tap opens the URL in the browser.
 */

import React from 'react';
import { Image, Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { LinkPreview } from '../api/client';
import { getColors } from '../theme/colors';

interface Props {
  preview: LinkPreview;
  isOwn: boolean;
  scheme: 'light' | 'dark';
}

export function LinkPreviewCard({ preview, isOwn, scheme }: Props) {
  const c = getColors(scheme);

  const handlePress = () => {
    Linking.openURL(preview.url).catch(() => {
      // Silently fail — URL may be malformed or unavailable.
    });
  };

  const bgColor = isOwn
    ? 'rgba(255,255,255,0.12)'
    : scheme === 'dark' ? c.surfaceElevated : '#F0F0F0';
  const borderColor = isOwn ? 'rgba(255,255,255,0.2)' : c.border;
  const titleColor = isOwn ? '#fff' : c.textPrimary;
  const descColor = isOwn ? 'rgba(255,255,255,0.75)' : c.textSecondary;
  const siteColor = isOwn ? 'rgba(255,255,255,0.55)' : c.textMuted;

  return (
    <TouchableOpacity
      activeOpacity={0.75}
      onPress={handlePress}
      style={[styles.card, { backgroundColor: bgColor, borderColor }]}
      accessibilityLabel={`Link preview: ${preview.title || preview.url}`}
      accessibilityRole="link"
    >
      {!!preview.image && (
        <Image
          source={{ uri: preview.image }}
          style={styles.thumb}
          resizeMode="cover"
        />
      )}
      <View style={styles.text}>
        <Text style={[styles.title, { color: titleColor }]} numberOfLines={2}>
          {preview.title}
        </Text>
        {!!preview.description && (
          <Text style={[styles.description, { color: descColor }]} numberOfLines={2}>
            {preview.description}
          </Text>
        )}
        {!!preview.siteName && (
          <Text style={[styles.siteName, { color: siteColor }]} numberOfLines={1}>
            {preview.siteName}
          </Text>
        )}
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    marginTop: 6,
    // Don't set maxWidth — the parent bubble column wrapper handles that.
  },
  thumb: {
    width: 60,
    height: 60,
    borderTopLeftRadius: 10,
    borderBottomLeftRadius: 10,
  },
  text: {
    flex: 1,
    padding: 8,
    gap: 2,
  },
  title: {
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 17,
  },
  description: {
    fontSize: 12,
    lineHeight: 16,
  },
  siteName: {
    fontSize: 11,
    marginTop: 2,
  },
});
