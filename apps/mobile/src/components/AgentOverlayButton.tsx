import { StyleSheet, TouchableOpacity, View } from 'react-native';
import { useChat } from '../contexts/ChatContext';
import { AppIcon } from './AppIcon';

interface AgentOverlayButtonProps {
  color: string;
  onPress: () => void;
  size?: number;
}

/** Shared agent entry point used by native headers and desktop sidebar chrome. */
export function AgentOverlayButton({ color, onPress, size = 20 }: AgentOverlayButtonProps) {
  const { pendingMatchCount } = useChat();
  const hasPending = pendingMatchCount > 0;

  return (
    <TouchableOpacity
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={hasPending ? `Agent network, ${pendingMatchCount} pending` : 'Agent network'}
      style={styles.button}
    >
      <AppIcon name="bot" color={color} size={size} />
      {hasPending && <View style={[styles.badge, { backgroundColor: color }]} />}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  button: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    top: 8,
    right: 7,
    width: 8,
    height: 8,
    borderRadius: 4,
  },
});
