import { describe, expect, it, vi } from 'vitest';
import type { EntryIntent, EntryTarget } from '../services/entryIntents';
import { routeEntryIntentIfReady } from './entryNavigation';

vi.mock('@react-navigation/native', () => ({
  CommonActions: { navigate: (payload: unknown) => ({ type: 'NAVIGATE', payload }) },
}));

function intent(target: EntryTarget): EntryIntent {
  return {
    version: 2,
    clientIntentId: 'one',
    target,
    capturedAt: '2026-09-29T00:00:00Z',
    continuation: 'native',
    phase: 'preview',
  };
}

function navigator(activeScreen: string, ready = true) {
  const dispatch = vi.fn();
  return {
    ref: {
      isReady: () => ready,
      getRootState: () => ({ index: 0, routes: [{ name: activeScreen }] }),
      dispatch,
    },
    dispatch,
  };
}

describe('entry navigation', () => {
  it('waits for the navigator and signed-in Main screen', () => {
    const entry = intent({ kind: 'group', token: 'invite-token' });
    const last = { current: null as string | null };
    const cold = navigator('Main', false);
    expect(routeEntryIntentIfReady(cold.ref, entry, last)).toBe(false);
    expect(cold.dispatch).not.toHaveBeenCalled();

    const login = navigator('Login');
    expect(routeEntryIntentIfReady(login.ref, entry, last)).toBe(false);
    expect(login.dispatch).not.toHaveBeenCalled();

    const onboarding = navigator('Onboarding');
    expect(routeEntryIntentIfReady(onboarding.ref, entry, last)).toBe(false);
    expect(onboarding.dispatch).not.toHaveBeenCalled();
    expect(last.current).toBeNull();
  });

  it.each([
    [{ kind: 'group', token: 'invite-token' }, 'GroupInvitePreview', { token: 'invite-token' }],
    [{ kind: 'person', userId: 'person-id' }, 'PersonEntry', { userId: 'person-id' }],
    [{ kind: 'card', token: 'card-token' }, 'CardEntry', { token: 'card-token' }],
  ] as const)('routes %j through the Chats tab once', (target, screen, params) => {
    const { ref, dispatch } = navigator('Main');
    const entry = intent(target);
    const last = { current: null as string | null };

    expect(routeEntryIntentIfReady(ref, entry, last)).toBe(true);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      payload: {
        name: 'Main',
        params: { screen: 'ChatsTab', params: { screen, params } },
      },
    }));
    expect(routeEntryIntentIfReady(ref, entry, last)).toBe(false);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
