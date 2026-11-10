/**
 * CopyButton — a small explicit "Copy" action for authored text. Shown where a
 * card has no long-press menu of its own, so copying never depends on finding
 * native selection handles. Confirms in place ("Copied") for screen readers too.
 */
import { useEffect, useRef, useState } from 'react';
import { Text, TouchableOpacity } from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { space, touchTarget, type } from '../theme/tokens';
import { copyText } from '../utils/copyText';

export function CopyButton({ text, label = 'Copy', accessibilityLabel, testID }: {
  text: string; label?: string; accessibilityLabel?: string; testID?: string;
}) {
  const c = getColors(useTheme().scheme);
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const onPress = async () => {
    const ok = await copyText(text);
    setStatus(ok ? 'copied' : 'failed');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus('idle'), 1800);
  };
  return <TouchableOpacity accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? label} testID={testID}
    disabled={!text} onPress={() => void onPress()}
    hitSlop={{ top: space[2], bottom: space[2], left: space[2], right: space[2] }}
    style={{ minHeight: touchTarget, justifyContent: 'center', paddingHorizontal: space[2] }}>
    <Text accessibilityLiveRegion="polite" style={{ ...type.label, color: status === 'failed' ? c.danger : c.primary }}>
      {status === 'copied' ? 'Copied' : status === 'failed' ? 'Could not copy' : label}
    </Text>
  </TouchableOpacity>;
}
