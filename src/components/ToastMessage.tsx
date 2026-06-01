/**
 * Simple in-app toast notification. Fades in, holds, fades out.
 * Usage: pass visible + message; the parent controls when to show it.
 *
 * The parent should set `visible=true` and after the duration flip it back.
 * We handle the fade animation internally.
 */

import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text } from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';

interface Props {
  visible: boolean;
  message: string;
  duration?: number; // ms to stay fully visible (default 2500)
}

export function ToastMessage({ visible, message, duration = 2500 }: Props) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }),
        Animated.delay(duration),
        Animated.timing(opacity, { toValue: 0, duration: 300, useNativeDriver: true }),
      ]).start();
    } else {
      opacity.setValue(0);
    }
  }, [visible, duration, opacity]);

  if (!visible && opacity.__getValue() === 0) return null;

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.container,
        { backgroundColor: scheme === 'dark' ? '#1e293b' : '#1f2937', opacity },
      ]}
    >
      <Text style={[styles.text, { color: '#f1f5f9' }]}>{message}</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    bottom: 80,
    alignSelf: 'center',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 24,
    maxWidth: '80%',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 6,
    zIndex: 9999,
  },
  text: {
    fontSize: 14,
    fontWeight: '500',
    textAlign: 'center',
  },
});
