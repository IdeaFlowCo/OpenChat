// Hold-to-grow chat emoji (OpenChat-o6t5): the size reached by holding must be
// the size that is sent, even when the platform's own long-press gesture fires
// while the finger is still down.
import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type PressProps = {
  onPressIn?: () => void;
  onPressOut?: () => void;
  onLongPress?: () => void;
  cancelable?: boolean;
  disabled?: boolean;
  style?: unknown;
  children?: React.ReactNode;
};

const rn = vi.hoisted(() => ({ os: 'web' as string, press: null as null | PressProps, text: null as null | Record<string, unknown> }));

vi.mock('react-native', async () => {
  const ReactActual = await import('react');
  class Value {
    constructor(public v: number) {}
    stopAnimation() {}
    interpolate() { return this; }
  }
  const Pressable = (props: PressProps) => { rn.press = props; return ReactActual.createElement('pressable', null, props.children); };
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
import { HOLD_LEVEL_MS, MAX_EMOJI_SIZE } from '../../mobile/src/utils/emojiMessage.js';

/**
 * What react-native-web does when the browser starts its own long-press
 * gesture on a touch screen while a Pressable is held: ResponderSystem treats
 * `contextmenu` and `selectionchange` as terminate events that the responder
 * may refuse, and PressResponder's onResponderTerminationRequest refuses only
 * when the Pressable is `cancelable={false}` (or, for contextmenu on touch,
 * when it has an `onLongPress`). A terminated press deactivates, which calls
 * onPressOut — while the finger is still on the glass.
 */
function browserLongPress(props: PressProps, event: 'contextmenu' | 'selectionchange') {
  const refusedByLongPress = event === 'contextmenu' && props.onLongPress != null;
  const refused = refusedByLongPress || props.cancelable === false;
  if (!refused) props.onPressOut?.();
}

let onSend: ReturnType<typeof vi.fn>;
let root: ReturnType<typeof create>;

async function mount() {
  onSend = vi.fn();
  await act(async () => { root = create(React.createElement(EmojiSendButton, { emoji: "🍓", onSend })); });
}

async function hold(ms: number, during?: (props: PressProps) => void) {
  await act(async () => { rn.press!.onPressIn?.(); });
  // The platform long-press arrives just after its ~450-500 ms delay.
  if (during && ms > 500) {
    await act(async () => { vi.advanceTimersByTime(500); });
    during(rn.press!);
    await act(async () => { vi.advanceTimersByTime(ms - 500); });
  } else {
    await act(async () => { vi.advanceTimersByTime(ms); });
  }
  await act(async () => { rn.press!.onPressOut?.(); });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-03T00:00:00Z'));
  rn.os = 'web';
  rn.press = null;
});
afterEach(() => {
  act(() => root?.unmount());
  vi.useRealTimers();
});

describe('EmojiSendButton hold-to-grow', () => {
  it('a tap sends size 1', async () => {
    await mount();
    await hold(80);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith(1);
  });

  it('each held level is the level sent', async () => {
    await mount();
    for (let level = 2; level <= MAX_EMOJI_SIZE; level++) {
      onSend.mockClear();
      await hold(HOLD_LEVEL_MS[level - 1] + 50);
      expect(onSend).toHaveBeenCalledWith(level);
    }
  });

  for (const event of ['contextmenu', 'selectionchange'] as const) {
    it(`a full hold survives the browser's long-press ${event} on touch web`, async () => {
      await mount();
      await hold(1700, props => browserLongPress(props, event));
      // Before the fix this sent size 2 at ~500 ms while still held, and the
      // release sent nothing.
      expect(onSend).toHaveBeenCalledTimes(1);
      expect(onSend).toHaveBeenCalledWith(MAX_EMOJI_SIZE);
    });
  }

  it('on web the button forbids panning, selection and the iOS callout, and the glyph is not selectable', async () => {
    await mount();
    const style = [rn.press!.style].flat(3).filter(Boolean).reduce<Record<string, unknown>>((all, s) => ({ ...all, ...(s as object) }), {});
    expect(style).toMatchObject({ touchAction: 'none', userSelect: 'none', WebkitTouchCallout: 'none' });
    expect(rn.text?.selectable).toBe(false);
  });

  it('native keeps the hold when an ancestor gesture asks for the touch', async () => {
    rn.os = 'ios';
    await mount();
    const style = [rn.press!.style].flat(3).filter(Boolean).reduce<Record<string, unknown>>((all, s) => ({ ...all, ...(s as object) }), {});
    expect(style.touchAction).toBeUndefined();
    expect(rn.press!.cancelable).toBe(false);
    await hold(1000);
    expect(onSend).toHaveBeenCalledWith(3);
  });

  it('a disabled button sends nothing', async () => {
    onSend = vi.fn();
    await act(async () => { root = create(React.createElement(EmojiSendButton, { emoji: "🍓", disabled: true, onSend })); });
    await hold(1700);
    expect(onSend).not.toHaveBeenCalled();
  });
});
