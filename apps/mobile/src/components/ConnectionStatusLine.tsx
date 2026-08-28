import { StyleSheet, Text, View } from 'react-native';

interface ConnectionStatusLineProps {
  account?: string;
  connected: boolean;
  connectedColor: string;
  disconnectedColor: string;
  textColor: string;
  disconnectedLabel?: string;
}

/** Compact account + realtime state used by both native and desktop headers. */
export function ConnectionStatusLine({
  account,
  connected,
  connectedColor,
  disconnectedColor,
  textColor,
  disconnectedLabel = 'reconnecting',
}: ConnectionStatusLineProps) {
  return (
    <View style={styles.row} accessibilityLabel={`${account || 'OpenChat'}. ${connected ? 'Connected' : disconnectedLabel}`}>
      {!!account && (
        <>
          <Text style={[styles.text, styles.account, { color: textColor }]} numberOfLines={1}>
            {account}
          </Text>
          <Text style={[styles.text, { color: textColor }]}>·</Text>
        </>
      )}
      <View
        style={[
          styles.dot,
          { backgroundColor: connected ? connectedColor : disconnectedColor },
        ]}
      />
      <Text style={[styles.text, { color: textColor }]} numberOfLines={1}>
        {connected ? 'connected' : disconnectedLabel}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    maxWidth: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  dot: { width: 7, height: 7, borderRadius: 4 },
  text: { fontSize: 11 },
  account: { flexShrink: 1 },
});
