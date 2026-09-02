/**
 * UpdateBanner (oc8.2 / openchat-3jq.1) — non-intrusive "update available" nudge.
 *
 * OTA path (EAS Update): expo-updates auto-checks ON_LOAD (see app.config.js).
 * When a newer JS bundle has been downloaded and is pending, we show a small
 * dismissible banner offering "Restart to update" -> Updates.reloadAsync().
 * Per the global rule: visible but NOT intrusive — a banner, never a blocking
 * modal, always dismissible, never blocks usage.
 *
 * No-ops safely in dev / Expo Go / when updates are disabled.
 *
 * Native binary updates (new TestFlight/App Store build that OTA can't deliver)
 * are intentionally NOT handled here yet — that needs a backend "latest native
 * version" endpoint (tracked separately; server repo). This component covers the
 * common case (JS/asset OTA) which is ~90% of updates.
 */
import { useEffect, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import * as Updates from 'expo-updates';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { AppIcon } from './AppIcon';

export function UpdateBanner() {
  const { scheme } = useTheme();
  const c = getColors(scheme);

  // expo-updates' hook: isUpdatePending becomes true once a new bundle has been
  // downloaded and is ready to apply on the next reload.
  const { isUpdatePending } = Updates.useUpdates();
  const [dismissed, setDismissed] = useState(false);
  const [reloading, setReloading] = useState(false);

  // Belt-and-suspenders: also actively check on mount in case ON_LOAD auto-check
  // hasn't fired yet. Guarded so it's a no-op in dev / when disabled.
  useEffect(() => {
    if (!Updates.isEnabled) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await Updates.checkForUpdateAsync();
        if (!cancelled && res.isAvailable) {
          await Updates.fetchUpdateAsync(); // flips isUpdatePending -> true
        }
      } catch {
        // offline / no update / not enabled — ignore silently
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!Updates.isEnabled || !isUpdatePending || dismissed) return null;

  const apply = async () => {
    setReloading(true);
    try {
      await Updates.reloadAsync();
    } catch {
      setReloading(false);
    }
  };

  return (
    <View style={[styles.bar, { backgroundColor: c.primary }]}>
      <Text style={styles.text} numberOfLines={1}>
        {reloading ? 'Updating…' : 'A new version is ready.'}
      </Text>
      <View style={styles.actions}>
        <TouchableOpacity onPress={apply} disabled={reloading} activeOpacity={0.8}>
          <Text style={styles.action}>Restart to update</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setDismissed(true)} hitSlop={8} activeOpacity={0.6}>
          <AppIcon name="x" color="#ffffff" size={14} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 8,
    gap: 12,
  },
  text: { color: '#fff', fontSize: 13, fontWeight: '600', flexShrink: 1 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  action: { color: '#fff', fontSize: 13, fontWeight: '700', textDecorationLine: 'underline' },
  dismiss: { color: 'rgba(255,255,255,0.85)', fontSize: 14, fontWeight: '700' },
});
