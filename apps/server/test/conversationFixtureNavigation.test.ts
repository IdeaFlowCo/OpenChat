import React, { useCallback } from 'react';
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { useFocusEffect, useNavigation, useRoute } from './fixtures/conversationNavigation';

it('keeps focus and route params stable through provider renders until navigation', async () => {
  const enter = vi.fn();
  const leave = vi.fn();
  let params: ReturnType<typeof useRoute>['params'];
  let navigation: ReturnType<typeof useNavigation>;
  function Probe({ update }: { update: number }) {
    const route = useRoute();
    params = route.params;
    navigation = useNavigation();
    useFocusEffect(useCallback(() => {
      enter(route.params.conversationId);
      return leave;
    }, [route.params]));
    return React.createElement('Fixture', { update });
  }
  let root!: ReturnType<typeof create>;
  await act(async () => { root = create(React.createElement(Probe, { update: 0 })); });
  try {
    const initial = params!;
    await act(async () => root.update(React.createElement(Probe, { update: 1 })));
    await act(async () => root.update(React.createElement(Probe, { update: 2 })));
    expect(params!).toBe(initial);
    expect(enter).toHaveBeenCalledExactlyOnceWith('sailing');
    expect(leave).not.toHaveBeenCalled();
    await act(async () => navigation!.navigate('Chat', { conversationId: 'other' }));
    expect(params!).toEqual({ conversationId: 'other' });
    expect(params!).not.toBe(initial);
    expect(enter).toHaveBeenLastCalledWith('other');
    expect(enter).toHaveBeenCalledTimes(2);
    expect(leave).toHaveBeenCalledOnce();
  } finally { await act(async () => root.unmount()); }
});
