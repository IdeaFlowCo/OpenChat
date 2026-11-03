// Hold-to-grow chat emoji (OpenChat-o6t5): the size reached by holding must be
// the size that is sent, even when the platform's own long-press gesture fires
// while the finger is still down.
import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type PressProps = {
  onPressIn?: (event: { nativeEvent: { type: string; pointerId?: number; changedTouches?: Array<{ identifier: number }> } }) => void;
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

function browserLongPress(props: PressProps, event: 'contextmenu' | 'selectionchange' | 'scroll') {
  if (event !== 'contextmenu' || !props.onLongPress) props.onPressOut?.();
}

let windowTarget: EventTarget;
let documentTarget: EventTarget & { visibilityState: string };
let documentAdd: ReturnType<typeof vi.spyOn>;
let documentRemove: ReturnType<typeof vi.spyOn>;
let addListener: ReturnType<typeof vi.spyOn>;
let removeListener: ReturnType<typeof vi.spyOn>;
function pointerEvent(type: string, pointerId = 1) {
  const event = new Event(type);
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  windowTarget.dispatchEvent(event);
}

function touchEvent(type: string, ...identifiers: number[]) {
  const event = new Event(type);
  Object.defineProperty(event, 'changedTouches', { value: identifiers.map(identifier => ({ identifier })) });
  windowTarget.dispatchEvent(event);
}

function expectListenersRemoved() {
  expect(removeListener.mock.calls.map(call => call[0]).sort()).toEqual(addListener.mock.calls.map(call => call[0]).sort());
  expect(documentRemove.mock.calls.map(call => call[0]).sort()).toEqual(documentAdd.mock.calls.map(call => call[0]).sort());
}

let onSend: ReturnType<typeof vi.fn>;
let root: ReturnType<typeof create>;

async function mount() {
  onSend = vi.fn();
  await act(async () => { root = create(React.createElement(EmojiSendButton, { emoji: "🍓", onSend })); });
}

async function hold(ms: number, during?: (props: PressProps) => void) {
  await act(async () => { rn.press!.onPressIn?.({ nativeEvent: { type: rn.os === 'web' ? 'pointerdown' : 'touchstart', pointerId: 1 } }); });
  // The platform long-press arrives just after its ~450-500 ms delay.
  if (during && ms > 500) {
    await act(async () => { vi.advanceTimersByTime(500); });
    during(rn.press!);
    expect(onSend).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(ms - 500); });
  } else {
    await act(async () => { vi.advanceTimersByTime(ms); });
  }
  await act(async () => { rn.press!.onPressOut?.(); if (rn.os === 'web') pointerEvent('pointerup'); });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-03T00:00:00Z'));
  windowTarget = new EventTarget();
  vi.stubGlobal('window', windowTarget);
  documentTarget = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  vi.stubGlobal('document', documentTarget);
  documentAdd = vi.spyOn(documentTarget, 'addEventListener');
  documentRemove = vi.spyOn(documentTarget, 'removeEventListener');
  addListener = vi.spyOn(windowTarget, 'addEventListener');
  removeListener = vi.spyOn(windowTarget, 'removeEventListener');
  rn.os = 'web';
  rn.press = null;
});
afterEach(() => {
  act(() => root?.unmount());
  vi.unstubAllGlobals();
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

  for (const event of ['contextmenu', 'selectionchange', 'scroll'] as const) {
    it(`a full hold survives the browser's long-press ${event} on touch web`, async () => {
      await mount();
      await hold(1700, props => browserLongPress(props, event));
      // Before the fix this sent size 2 at ~500 ms while still held, and the
      // release sent nothing.
      expect(onSend).toHaveBeenCalledTimes(1);
      expect(onSend).toHaveBeenCalledWith(MAX_EMOJI_SIZE);
    });
  }

  it('sends keyboard presses on press out', async () => {
    await mount();
    await act(async () => { rn.press!.onPressIn?.({ nativeEvent: { type: 'keydown' } }); });
    await act(async () => { rn.press!.onPressOut?.(); });
    expect(onSend).toHaveBeenCalledExactlyOnceWith(1);
    expect(addListener).not.toHaveBeenCalled();
  });

  it('removes pointer listeners on cancellation and unmount', async () => {
    await mount();
    await act(async () => { rn.press!.onPressIn?.({ nativeEvent: { type: 'pointerdown', pointerId: 1 } }); });
    await act(async () => { pointerEvent('pointercancel'); });
    expect(onSend).toHaveBeenCalledExactlyOnceWith(1);
    expectListenersRemoved();
    await act(async () => { rn.press!.onPressIn?.({ nativeEvent: { type: 'pointerdown', pointerId: 1 } }); });
    act(() => root.unmount());
    expectListenersRemoved();
    pointerEvent('pointerup');
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('ignores a different pointer and removes listeners after release', async () => {
    await mount();
    await act(async () => { rn.press!.onPressIn?.({ nativeEvent: { type: 'pointerdown', pointerId: 1 } }); });
    await act(async () => { pointerEvent('pointerup', 2); });
    expect(onSend).not.toHaveBeenCalled();
    await act(async () => { pointerEvent('pointerup'); });
    expect(onSend).toHaveBeenCalledExactlyOnceWith(1);
    expectListenersRemoved();
  });

  it('waits for the initiating touch and ignores other fingers', async () => {
    await mount();
    await act(async () => { rn.press!.onPressIn?.({ nativeEvent: { type: 'touchstart', changedTouches: [{ identifier: 7 }] } }); });
    await act(async () => { vi.advanceTimersByTime(500); browserLongPress(rn.press!, 'selectionchange'); touchEvent('touchend', 8); });
    expect(onSend).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1200); touchEvent('touchend', 7); });
    expect(onSend).toHaveBeenCalledExactlyOnceWith(MAX_EMOJI_SIZE);
    expectListenersRemoved();
  });

  it('ends on blur and ignores later releases', async () => {
    await mount();
    await act(async () => { rn.press!.onPressIn?.({ nativeEvent: { type: 'pointerdown', pointerId: 1 } }); });
    await act(async () => { vi.advanceTimersByTime(1000); windowTarget.dispatchEvent(new Event('blur')); });
    expect(onSend).toHaveBeenCalledExactlyOnceWith(3);
    expectListenersRemoved();
    await act(async () => { pointerEvent('pointerup'); rn.press!.onPressOut?.(); });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('ends when hidden or when a released mouse re-enters', async () => {
    await mount();
    await act(async () => { rn.press!.onPressIn?.({ nativeEvent: { type: 'mousedown' } }); });
    await act(async () => { documentTarget.visibilityState = 'hidden'; documentTarget.dispatchEvent(new Event('visibilitychange')); });
    expect(onSend).toHaveBeenCalledTimes(1);
    expectListenersRemoved();
    documentTarget.visibilityState = 'visible';
    await act(async () => { rn.press!.onPressIn?.({ nativeEvent: { type: 'mousedown' } }); });
    await act(async () => {
      windowTarget.dispatchEvent(new Event('mouseleave'));
      const enter = new Event('mouseenter');
      Object.defineProperty(enter, 'buttons', { value: 1 });
      windowTarget.dispatchEvent(enter);
    });
    expect(onSend).toHaveBeenCalledTimes(1);
    await act(async () => {
      windowTarget.dispatchEvent(new Event('mouseleave'));
      const enter = new Event('mouseenter');
      Object.defineProperty(enter, 'buttons', { value: 0 });
      windowTarget.dispatchEvent(enter);
    });
    expect(onSend).toHaveBeenCalledTimes(2);
    expectListenersRemoved();
  });

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
