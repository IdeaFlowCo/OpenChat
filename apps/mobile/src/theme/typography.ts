/**
 * Warm Paper + System Sans — approved product direction, 6 October 2026.
 * Use platform system fonts throughout, including headings. The historical
 * `serif` export remains an alias so existing screens stay visually aligned.
 */
import { Platform } from 'react-native';

/** System sans is Jacob's approved product direction. Keep the legacy token name
 * while callers migrate, so every existing heading gets the same treatment. */
export const serif = Platform.select({
  ios: 'System', android: 'sans-serif', default: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
}) as string;

/** Nav-bar / screen titles. */
export const displayTitle = {
  fontFamily: serif,
  fontWeight: '600' as const,
  letterSpacing: 0.1,
};

/** Small, letterspaced caps labels (kind badges, section headers). */
export const capsLabel = {
  fontSize: 10.5,
  fontWeight: '700' as const,
  letterSpacing: 1.1,
  textTransform: 'uppercase' as const,
};
