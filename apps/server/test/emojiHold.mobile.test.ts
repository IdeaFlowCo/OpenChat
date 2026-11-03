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

let host: EventTarget & { setPointerCapture: ReturnType<typeof vi.fn>; releasePointerCapture: ReturnType<typeof vi.fn> };
let win: EventTarget;
let doc: EventTarget & { visibilityState: string };
let hostAdd: ReturnType<typeof vi.spyOn>, hostRemove: ReturnType<typeof vi.spyOn>;
let winAdd: ReturnType<typeof vi.spyOn>, winRemove: ReturnType<typeof vi.spyOn>;
let docAdd: ReturnType<typeof vi.spyOn>, docRemove: ReturnType<typeof vi.spyOn>;
let onSend: ReturnType<typeof vi.fn>;
let root: ReturnType<typeof create>;

function pointer(target: EventTarget, type: string, id = 1, pointerType = 'touch', button = 0) {
  const event = new Event(type);
  Object.defineProperties(event, { pointerId: { value: id }, pointerType: { value: pointerType }, button: { value: button } });
  target.dispatchEvent(event);
}
function responder(type: string): PressEvent { return { nativeEvent: { type } }; }

// RN-web ResponderSystem.js and PressResponder.js terminate on selectionchange
// or touchcancel despite cancelable on Pressable, but refuse contextmenu when
// onLongPress exists. Before the fix, termination sent size 2 at 500 ms.
function terminateResponder(type: 'contextmenu' | 'selectionchange' | 'touchcancel') {
  if (type !== 'contextmenu' || !rn.press!.onLongPress) rn.press!.onPressOut?.(responder(type));
}
function removed(add: ReturnType<typeof vi.spyOn>, remove: ReturnType<typeof vi.spyOn>) {
  expect(remove.mock.calls.map(call => call[0]).sort()).toEqual(add.mock.calls.map(call => call[0]).sort());
}
async function mount(disabled = false) {
  onSend = vi.fn();
  await act(async () => { root = create(React.createElement(EmojiSendButton, { emoji: '🍓', onSend, disabled }), { createNodeMock: () => host }); });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-03T00:00:00Z'));
  host = Object.assign(new EventTarget(), { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() });
  win = new EventTarget();
  doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
  hostAdd = vi.spyOn(host, 'addEventListener'); hostRemove = vi.spyOn(host, 'removeEventListener');
  winAdd = vi.spyOn(win, 'addEventListener'); winRemove = vi.spyOn(win, 'removeEventListener');
  docAdd = vi.spyOn(doc, 'addEventListener'); docRemove = vi.spyOn(doc, 'removeEventListener');
  rn.os = 'web'; rn.press = null;
});
afterEach(() => { act(() => root?.unmount()); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('EmojiSendButton hold-to-grow', () => {
  it('sends a quick tap before responder activation', async () => {
    await mount();
    await act(async () => { pointer(host, 'pointerdown'); vi.advanceTimersByTime(20); pointer(win, 'pointerup'); });
    expect(onSend).toHaveBeenCalledExactlyOnceWith(1);
    expect(host.setPointerCapture).toHaveBeenCalledWith(1);
    expect(host.releasePointerCapture).toHaveBeenCalledWith(1);
    removed(winAdd, winRemove); removed(docAdd, docRemove);
  });
  it('holds through responder termination and ignores other contacts', async () => {
    await mount();
    await act(async () => {
      pointer(host, 'pointerdown', 27);
      pointer(host, 'pointerdown', 7);
      vi.advanceTimersByTime(500);
      terminateResponder('contextmenu');
      terminateResponder('selectionchange');
      pointer(win, 'pointerup', 7);
    });
    expect(onSend).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1200); pointer(win, 'pointerup', 27); });
    expect(onSend).toHaveBeenCalledExactlyOnceWith(MAX_EMOJI_SIZE);
    removed(winAdd, winRemove); removed(docAdd, docRemove);
  });
  it('tracks a pen and rejects secondary mouse buttons', async () => {
    await mount();
    await act(async () => { pointer(host, 'pointerdown', 1, 'mouse', 2); pointer(host, 'pointerdown', 9, 'pen'); vi.advanceTimersByTime(1000); pointer(win, 'pointerup', 9, 'pen'); });
    expect(onSend).toHaveBeenCalledExactlyOnceWith(3);
    removed(winAdd, winRemove); removed(docAdd, docRemove);
  });
  for (const ending of ['pointercancel', 'lostpointercapture', 'blur', 'hidden'] as const) {
    it(`ends once on ${ending}`, async () => {
      await mount();
      await act(async () => {
        pointer(host, 'pointerdown'); vi.advanceTimersByTime(1000);
        if (ending === 'blur') win.dispatchEvent(new Event('blur'));
        else if (ending === 'hidden') { doc.visibilityState = 'hidden'; doc.dispatchEvent(new Event('visibilitychange')); }
        else pointer(ending === 'lostpointercapture' ? host : win, ending);
        pointer(win, 'pointerup');
      });
      expect(onSend).toHaveBeenCalledExactlyOnceWith(3);
      removed(winAdd, winRemove); removed(docAdd, docRemove);
    });
  }
  it('handles keyboard presses and ignores web pointer responder callbacks', async () => {
    await mount();
    await act(async () => { rn.press!.onPressIn?.(responder('mousedown')); rn.press!.onPressOut?.(responder('mouseup')); });
    expect(onSend).not.toHaveBeenCalled();
    await act(async () => { rn.press!.onPressIn?.(responder('keydown')); rn.press!.onPressOut?.({ type: 'keyup', key: 'Enter' }); });
    expect(onSend).toHaveBeenCalledExactlyOnceWith(1);
    await act(async () => { rn.press!.onPressIn?.({ type: 'keydown', key: ' ' }); rn.press!.onPressOut?.(responder('keyup')); });
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(onSend).toHaveBeenLastCalledWith(1);
  });
  it('finishes a terminated keyboard hold and accepts another', async () => {
    await mount();
    await act(async () => { rn.press!.onPressIn?.(responder('keydown')); vi.advanceTimersByTime(1000); terminateResponder('selectionchange'); });
    expect(onSend).toHaveBeenCalledExactlyOnceWith(3);
    await act(async () => { rn.press!.onPressOut?.({ type: 'keyup', key: 'Enter' }); rn.press!.onPressIn?.(responder('keydown')); rn.press!.onPressOut?.({ type: 'keyup', key: 'Enter' }); });
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(onSend).toHaveBeenLastCalledWith(1);
  });
  it('replaces host listeners on ref detachment and reattachment', async () => {
    await mount();
    const ref = rn.press!.ref as (node: unknown) => void;
    await act(async () => { pointer(host, 'pointerdown'); ref(null); ref(host); ref(host); });
    expect(host.releasePointerCapture).toHaveBeenCalledWith(1);
    removed(winAdd, winRemove); removed(docAdd, docRemove);
    expect(hostAdd.mock.calls.filter(call => call[0] === 'pointerdown')).toHaveLength(2);
    expect(hostRemove.mock.calls.filter(call => call[0] === 'pointerdown')).toHaveLength(1);
    await act(async () => { pointer(host, 'pointerdown'); pointer(win, 'pointerup'); });
    expect(onSend).toHaveBeenCalledExactlyOnceWith(1);
    act(() => root.unmount());
    removed(hostAdd, hostRemove);
    pointer(host, 'pointerdown'); pointer(win, 'pointerup');
    expect(onSend).toHaveBeenCalledTimes(1);
  });
  it('cleans up an active hold on unmount', async () => {
    await mount();
    await act(async () => { pointer(host, 'pointerdown'); root.unmount(); });
    removed(hostAdd, hostRemove); removed(winAdd, winRemove); removed(docAdd, docRemove);
    expect(host.releasePointerCapture).toHaveBeenCalledWith(1);
    pointer(win, 'pointerup'); expect(onSend).not.toHaveBeenCalled();
  });
  it('keeps native responder behavior', async () => {
    rn.os = 'ios'; await mount();
    expect(rn.press!.cancelable).toBe(false);
    await act(async () => { rn.press!.onPressIn?.(responder('touchstart')); vi.advanceTimersByTime(1000); rn.press!.onPressOut?.(responder('touchend')); });
    expect(onSend).toHaveBeenCalledExactlyOnceWith(3);
  });
  it('does not start when disabled', async () => {
    await mount(true);
    await act(async () => { pointer(host, 'pointerdown'); pointer(win, 'pointerup'); });
    expect(onSend).not.toHaveBeenCalled();
  });
});
