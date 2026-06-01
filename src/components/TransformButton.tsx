/**
 * TransformButton — sparkle button in the composer toolbar.
 *
 * Tap opens an ActionSheet (iOS) or a modal picker (Android/web) with 5
 * transform options. Translate opens a second language picker.
 *
 * Props:
 *   disabled   — true while text is empty or a request is in-flight
 *   onTransformed(text, label) — called with the rewritten text + label
 */

import React, { useState } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import {
  transformMessage,
  TransformType,
  TRANSFORM_LABELS,
  TRANSLATE_LANGUAGES,
} from '../services/messageTransform';
import { ApiError } from '../api/client';

interface Props {
  text: string;
  disabled?: boolean;
  onTransformed: (rewrittenText: string, label: string) => void;
  onError: (msg: string) => void;
}

const TRANSFORMS: TransformType[] = ['nvc', 'concise', 'formal', 'casual', 'translate'];

export function TransformButton({ text, disabled, onTransformed, onError }: Props) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const [loading, setLoading] = useState(false);

  // Android/web modal state
  const [modalVisible, setModalVisible] = useState(false);
  const [langModalVisible, setLangModalVisible] = useState(false);

  async function runTransform(transform: TransformType, targetLanguage?: string) {
    setLoading(true);
    try {
      const rewritten = await transformMessage(text, transform, { targetLanguage });
      const label = transform === 'translate' && targetLanguage
        ? `Translate → ${targetLanguage}`
        : TRANSFORM_LABELS[transform];
      onTransformed(rewritten, label);
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        onError('Rate limit reached. Try again in a minute.');
      } else if (err instanceof ApiError && err.status === 503) {
        onError('Transform feature is not available right now.');
      } else {
        onError('Transform failed. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  }

  function showTransformPicker() {
    if (Platform.OS === 'ios') {
      const options = [...TRANSFORMS.map(t => TRANSFORM_LABELS[t]), 'Cancel'];
      ActionSheetIOS.showActionSheetWithOptions(
        { options, cancelButtonIndex: options.length - 1, title: 'Transform message' },
        async (idx) => {
          if (idx >= TRANSFORMS.length) return; // Cancel
          const picked = TRANSFORMS[idx];
          if (picked === 'translate') {
            showLanguagePicker_iOS();
          } else {
            await runTransform(picked);
          }
        },
      );
    } else {
      setModalVisible(true);
    }
  }

  function showLanguagePicker_iOS() {
    const options = [...TRANSLATE_LANGUAGES, 'Cancel'];
    ActionSheetIOS.showActionSheetWithOptions(
      { options, cancelButtonIndex: options.length - 1, title: 'Translate to…' },
      async (idx) => {
        if (idx >= TRANSLATE_LANGUAGES.length) return;
        await runTransform('translate', TRANSLATE_LANGUAGES[idx]);
      },
    );
  }

  async function handleAndroidTransformPick(transform: TransformType) {
    setModalVisible(false);
    if (transform === 'translate') {
      setLangModalVisible(true);
    } else {
      await runTransform(transform);
    }
  }

  async function handleAndroidLangPick(lang: string) {
    setLangModalVisible(false);
    await runTransform('translate', lang);
  }

  return (
    <>
      <TouchableOpacity
        onPress={showTransformPicker}
        disabled={disabled || loading}
        style={[styles.btn, { opacity: disabled || loading ? 0.4 : 1 }]}
        accessibilityLabel="Transform message"
      >
        {loading ? (
          <ActivityIndicator size="small" color={c.primary} />
        ) : (
          <Text style={styles.sparkle}>✨</Text>
        )}
      </TouchableOpacity>

      {/* Android/web: transform picker modal */}
      <Modal
        visible={modalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setModalVisible(false)}
      >
        <TouchableOpacity
          style={styles.overlay}
          activeOpacity={1}
          onPress={() => setModalVisible(false)}
        >
          <View style={[styles.sheet, { backgroundColor: c.surface, borderColor: c.border }]}>
            <Text style={[styles.sheetTitle, { color: c.textSecondary }]}>Transform message</Text>
            {TRANSFORMS.map(t => (
              <TouchableOpacity
                key={t}
                style={[styles.sheetRow, { borderTopColor: c.divider }]}
                onPress={() => void handleAndroidTransformPick(t)}
              >
                <Text style={[styles.sheetRowText, { color: c.textPrimary }]}>
                  {TRANSFORM_LABELS[t]}
                </Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity
              style={[styles.sheetRow, { borderTopColor: c.divider }]}
              onPress={() => setModalVisible(false)}
            >
              <Text style={[styles.sheetRowText, { color: c.textMuted }]}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Android/web: language picker modal */}
      <Modal
        visible={langModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setLangModalVisible(false)}
      >
        <TouchableOpacity
          style={styles.overlay}
          activeOpacity={1}
          onPress={() => setLangModalVisible(false)}
        >
          <View style={[styles.sheet, { backgroundColor: c.surface, borderColor: c.border }]}>
            <Text style={[styles.sheetTitle, { color: c.textSecondary }]}>Translate to…</Text>
            {TRANSLATE_LANGUAGES.map(lang => (
              <TouchableOpacity
                key={lang}
                style={[styles.sheetRow, { borderTopColor: c.divider }]}
                onPress={() => void handleAndroidLangPick(lang)}
              >
                <Text style={[styles.sheetRowText, { color: c.textPrimary }]}>{lang}</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity
              style={[styles.sheetRow, { borderTopColor: c.divider }]}
              onPress={() => setLangModalVisible(false)}
            >
              <Text style={[styles.sheetRowText, { color: c.textMuted }]}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  btn: {
    paddingBottom: 6,
    paddingRight: 2,
    width: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sparkle: {
    fontSize: 20,
  },
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopWidth: 1,
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    paddingBottom: 32,
  },
  sheetTitle: {
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
    paddingVertical: 14,
    letterSpacing: 0.3,
  },
  sheetRow: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: 16,
    paddingHorizontal: 20,
  },
  sheetRowText: {
    fontSize: 17,
    textAlign: 'center',
  },
});
