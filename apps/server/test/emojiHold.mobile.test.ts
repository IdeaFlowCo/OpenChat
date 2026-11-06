import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type PressEvent = { nativeEvent: { type: string; key?: string } } | { type: string; key?: string };
type PressProps = {
  onPressIn?: (event: PressEvent) => void;
  onPressOut?: (event: PressEvent) => void;
  onLongPress?: () => void;
  cancelable?: boolean;
  style?: unknown;
  children?: React.ReactNode;
  ref?: React.Ref<unknown>;
};
const rn = vi.hoisted(() => ({ os: 'web' as string, press: null as PressProps | null, text: null as Record<string, unknown> | null }));
vi.mock('react-native', async () => {
  const ReactActual = await import('react');
  class Value {
    constructor(public v: number) {}
    stopAnimation() {}
    interpolate() { return this; }
  }
  const Pressable = (props: PressProps) => { rn.press = props; return ReactActual.createElement('pressable', { ref: (node: unknown) => { if (typeof props.ref === 'function') props.ref(node); } }, props.children); };
  const Text = (props: Record<string, unknown>) => { rn.text = props; return ReactActual.createElement('text', null, props.children as React.ReactNode); };
  const View = (props: { children?: React.ReactNode }) => ReactActual.createElement('view', null, props.children);
  return {
    Platform: { get OS() { return rn.os; }, select: (v: Record<string, unknown>) => v[rn.os] ?? v.default },
    Pressable, Text, View,
    Animated: { Value, View, timing: () => ({ start() {} }), spring: () => ({ start() {} }) },
    Easing: { out: (f: unknown) => f, quad: () => 0 },
    StyleSheet: { create: <T,>(s: T) => s, flatten: (s: unknown) => s },
  };
});
vi.mock('../../mobile/src/services/haptics', () => ({ hapticGrowTick: vi.fn() }));
import { EmojiSendButton } from '../../mobile/src/components/EmojiSendButton.js';
import { MAX_EMOJI_SIZE } from '../../mobile/src/utils/emojiMessage.js';

let onSend: ReturnType<typeof vi.fn>;
let root: ReturnType<typeof create>;
function responder(type: string): PressEvent { return { nativeEvent: { type } }; }
async function mount(disabled = false) {
  onSend = vi.fn();
  await act(async () => { root = create(React.createElement(EmojiSendButton, { emoji: '🍓', onSend, disabled })); });
}
// Model RN-web contextmenu termination and browser selection/pan triggers.
function browserLongPress() {
  const props = rn.press!;
  const style = Object.assign({}, ...(props.style as object[]).filter(Boolean));
  props.onLongPress?.();
  if (!props.onLongPress || (rn.text?.selectable !== false && style.userSelect !== 'none') || style.touchAction !== 'none') props.onPressOut?.(responder('touchcancel'));
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-03T00:00:00Z')); rn.os = 'web'; rn.press = null; rn.text = null; });
afterEach(() => { act(() => root?.unmount()); vi.useRealTimers(); });
describe('EmojiSendButton hold-to-grow', () => {
  it('continues a web touch hold through the browser long press', async () => {
    await mount();
    await act(async () => { rn.press!.onPressIn?.(responder('touchstart')); vi.advanceTimersByTime(500); browserLongPress(); });
    expect(onSend).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1200); rn.press!.onPressOut?.(responder('touchend')); });
    expect(onSend).toHaveBeenCalledExactlyOnceWith(MAX_EMOJI_SIZE);
  });
  it('sends a keyboard tap', async () => {
    await mount();
    await act(async () => { rn.press!.onPressIn?.(responder('keydown')); vi.advanceTimersByTime(20); rn.press!.onPressOut?.(responder('keyup')); });
    expect(onSend).toHaveBeenCalledExactlyOnceWith(1);
  });
  it('sends the reached level when a native press terminates', async () => {
    rn.os = 'ios'; await mount();
    expect(rn.press!.cancelable).toBe(false);
    await act(async () => { rn.press!.onPressIn?.(responder('touchstart')); vi.advanceTimersByTime(1000); rn.press!.onPressOut?.(responder('touchcancel')); rn.press!.onPressOut?.(responder('touchend')); });
    expect(onSend).toHaveBeenCalledExactlyOnceWith(3);
  });
  it('bounds long holds and ignores disabled presses', async () => {
    await mount();
    await act(async () => { rn.press!.onPressIn?.(responder('touchstart')); vi.advanceTimersByTime(10000); rn.press!.onPressOut?.(responder('touchend')); });
    expect(onSend).toHaveBeenCalledExactlyOnceWith(MAX_EMOJI_SIZE);
    await act(async () => { root.unmount(); });
    await mount(true);
    await act(async () => { rn.press!.onPressIn?.(responder('touchstart')); rn.press!.onPressOut?.(responder('touchend')); });
    expect(onSend).not.toHaveBeenCalled();
  });
  it('does not send after unmounting an active hold', async () => {
    await mount();
    await act(async () => { rn.press!.onPressIn?.(responder('touchstart')); root.unmount(); vi.advanceTimersByTime(2000); });
    expect(onSend).not.toHaveBeenCalled();
  });
});
