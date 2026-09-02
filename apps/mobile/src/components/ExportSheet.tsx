import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { EXPORT_RANGE_OPTIONS, ExportRangeKey } from '../api/client';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';

interface ExportSheetProps {
  visible: boolean;
  title: string;
  subtitle: string;
  disabledReason?: string | null;
  busyRange?: ExportRangeKey | null;
  onClose: () => void;
  onExport: (range: ExportRangeKey) => void;
}

export function ExportSheet({
  visible,
  title,
  subtitle,
  disabledReason,
  busyRange,
  onClose,
  onExport,
}: ExportSheetProps) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const disabled = !!disabledReason || !!busyRange;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      {/* Tap anywhere outside the sheet to dismiss (2026-09-02 feedback:
          "you shouldn't have to hit X — just tap out"). */}
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable onPress={() => { /* swallow taps inside the sheet */ }} style={[styles.sheet, { backgroundColor: c.surface, borderColor: c.border }]}>
          <View style={styles.header}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.title, { color: c.textPrimary }]}>{title}</Text>
              <Text style={[styles.subtitle, { color: c.textSecondary }]}>{subtitle}</Text>
            </View>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn} accessibilityLabel="Close export options">
              <Text style={{ color: c.textMuted, fontSize: 22 }}>×</Text>
            </TouchableOpacity>
          </View>

          {disabledReason ? (
            <View style={[styles.notice, { backgroundColor: c.surfaceElevated, borderColor: c.border }]}>
              <Text style={[styles.noticeText, { color: c.textSecondary }]}>{disabledReason}</Text>
            </View>
          ) : null}

          <View style={[styles.options, { borderColor: c.border }]}>
            {EXPORT_RANGE_OPTIONS.map((range, index) => {
              const loading = busyRange === range.key;
              return (
                <TouchableOpacity
                  key={range.key}
                  disabled={disabled && !loading}
                  onPress={() => onExport(range.key)}
                  activeOpacity={0.72}
                  style={[
                    styles.optionRow,
                    index < EXPORT_RANGE_OPTIONS.length - 1 && {
                      borderBottomWidth: StyleSheet.hairlineWidth,
                      borderBottomColor: c.divider,
                    },
                    disabled && !loading ? { opacity: 0.45 } : null,
                  ]}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.optionLabel, { color: c.textPrimary }]}>{range.label}</Text>
                    <Text style={[styles.optionDetail, { color: c.textSecondary }]}>{range.detail}</Text>
                  </View>
                  {loading ? (
                    <ActivityIndicator color={c.primary} />
                  ) : (
                    <Text style={{ color: c.primary, fontSize: 18 }}>↓</Text>
                  )}
                </TouchableOpacity>
              );
            })}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.42)',
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 28,
    gap: 14,
  },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  title: { fontSize: 19, fontWeight: '700' },
  subtitle: { fontSize: 13, lineHeight: 18, marginTop: 3 },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  notice: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  noticeText: { fontSize: 13, lineHeight: 18 },
  options: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    overflow: 'hidden',
  },
  optionRow: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 12,
  },
  optionLabel: { fontSize: 16, fontWeight: '600' },
  optionDetail: { fontSize: 12, marginTop: 2 },
});
