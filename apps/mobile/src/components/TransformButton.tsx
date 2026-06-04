/**
 * TransformButton — sparkle button in the composer toolbar.
 *
 * UX: tap the ✨ sparkle = run the DEFAULT transform (NVC). Tap the small
 * ▾ chevron next to it = open the picker for other transforms (concise,
 * formal, casual, translate). Translate opens a second language picker.
 *
 * Props:
 *   disabled   — true while text is empty or a request is in-flight
 *   onTransformed(text, label) — called with the rewritten text + label
 *   onError(msg) — called with a user-visible error string
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

const DEFAULT_TRANSFORM: TransformType = 'nvc';
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
      // Show the actual error so failures are debuggable rather than opaque.
      // ApiError.message is already "{status}: {server-message}"; for any
      // other error type we fall through to the JS error message string.
      const baseMsg =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      let userMsg = baseMsg;
      if (err instanceof ApiError && err.status === 429) {
        userMsg = 'Rate limit reached. Try again in a minute.';
      } else if (err instanceof ApiError && err.status === 503) {
        userMsg = 'AI transform is not configured on the server yet.';
      }
      onError(`Transform: ${userMsg}`);
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
      {/* Sparkle = run default (NVC); ▾ = open picker for other transforms */}
      <View style={styles.btnGroup}>
        <TouchableOpacity
          onPress={() => void runTransform(DEFAULT_TRANSFORM)}
          disabled={disabled || loading}
          style={[styles.btnSparkle, { opacity: disabled || loading ? 0.4 : 1 }]}
          accessibilityLabel={`Transform message (${TRANSFORM_LABELS[DEFAULT_TRANSFORM]})`}
        >
          {loading ? (
            <ActivityIndicator size="small" color={c.primary} />
          ) : (
            <Text style={styles.sparkle}>✨</Text>
          )}
        </TouchableOpacity>
        <TouchableOpacity
          onPress={showTransformPicker}
          disabled={disabled || loading}
          style={[styles.btnChevron, { opacity: disabled || loading ? 0.4 : 1 }]}
          accessibilityLabel="Choose transform"
        >
          <Text style={[styles.chevron, { color: c.textMuted }]}>▾</Text>
        </TouchableOpacity>
      </View>

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
  btnGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingBottom: 6,
  },
  btnSparkle: {
    paddingHorizontal: 4,
    width: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnChevron: {
    paddingHorizontal: 2,
    paddingRight: 4,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: -4,
  },
  chevron: {
    fontSize: 14,
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
