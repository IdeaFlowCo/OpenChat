import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';

interface Props {
  activeLane: 'chat' | 'context';
  onChange: (lane: 'chat' | 'context') => void;
}

export function ConversationLaneSwitch({ activeLane, onChange }: Props) {
  const { scheme } = useTheme();
  const c = getColors(scheme);

  return (
    <View style={[styles.container, { backgroundColor: c.background, borderBottomColor: c.border }]}>
      <View style={[styles.switchTrack, { backgroundColor: c.surfaceElevated }]}>
        <TouchableOpacity
          style={[styles.segment, activeLane === 'chat' && [styles.segmentActive, { backgroundColor: c.background, shadowColor: '#000' }]]}
          onPress={() => onChange('chat')}
          accessibilityRole="tab"
          accessibilityState={{ selected: activeLane === 'chat' }}
          accessibilityLabel="Chat"
        >
          <Text style={[styles.label, { color: activeLane === 'chat' ? c.textPrimary : c.textMuted }]}>Chat</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.segment, activeLane === 'context' && [styles.segmentActive, { backgroundColor: c.background, shadowColor: '#000' }]]}
          onPress={() => onChange('context')}
          accessibilityRole="tab"
          accessibilityState={{ selected: activeLane === 'context' }}
          accessibilityLabel="Context"
        >
          <Text style={[styles.label, { color: activeLane === 'context' ? c.textPrimary : c.textMuted }]}>Context</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  switchTrack: {
    flexDirection: 'row',
    borderRadius: 8,
    padding: 2,
  },
  segment: {
    flex: 1,
    paddingVertical: 6,
    alignItems: 'center',
    borderRadius: 6,
  },
  segmentActive: {
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 1,
    elevation: 2,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
  },
});
