/**
 * Tiny colored dot indicating online presence. Shape matches the web client
 * PresenceIndicator (.sm size).
 */
import { StyleSheet, View } from 'react-native';

export type PresenceStatus = 'available' | 'away' | 'busy' | 'invisible' | 'offline' | string;

interface Props {
  status?: PresenceStatus;
  size?: number;
}

export function PresenceDot({ status, size = 10 }: Props) {
  let color = '#9ca3af'; // gray (offline/unknown)
  switch (status) {
    case 'available': color = '#10b981'; break;
    case 'away':      color = '#f59e0b'; break;
    case 'busy':      color = '#ef4444'; break;
    case 'invisible':
    case 'offline':
    default:          color = '#9ca3af';
  }
  return (
    <View
      style={[
        styles.dot,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: color,
        },
      ]}
      accessibilityLabel={`presence: ${status ?? 'unknown'}`}
    />
  );
}

const styles = StyleSheet.create({
  dot: {
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.9)',
  },
});
