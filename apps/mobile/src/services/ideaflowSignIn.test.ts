import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchIdeaflowConfig,
  ideaflowCallbackErrorMessage,
  ideaflowStartQuery,
  loginSurface,
  markIdeaflowAccountChoice,
  prepareIdeaflowWebSignIn,
  takeIdeaflowAccountChoice,
} from './ideaflowSignIn';

const enabled = { status: 'ready', enabled: true, passwordResetUrl: null } as const;
const disabled = { status: 'ready', enabled: false, passwordResetUrl: null } as const;

describe('loginSurface', () => {
  it('shows only the single Sign in with Ideaflow button on web when enabled', () => {
    expect(loginSurface({ isWeb: true, config: enabled })).toEqual({
      pending: false, ideaflow: true, legacy: false, legacyFooter: false,
    });
  });

  it('renders no method while the web capability check is in flight', () => {
    expect(loginSurface({ isWeb: true, config: { status: 'loading' } })).toEqual({
      pending: true, ideaflow: false, legacy: false, legacyFooter: false,
    });
  });

  it('falls back to legacy methods on web when the server disables Ideaflow', () => {
    expect(loginSurface({ isWeb: true, config: disabled })).toEqual({
      pending: false, ideaflow: false, legacy: true, legacyFooter: false,
    });
  });

  it('leaves native unchanged regardless of config', () => {
    for (const config of [enabled, disabled, { status: 'loading' } as const]) {
      expect(loginSurface({ isWeb: false, config })).toEqual({
        pending: false, ideaflow: false, legacy: true, legacyFooter: true,
      });
    }
  });
});

describe('ideaflowCallbackErrorMessage', () => {
  it('uses fixed copy and never echoes provider text', () => {
    expect(ideaflowCallbackErrorMessage({ stateMatched: false, error: null }))
      .toBe('That sign-in took too long or was interrupted. Please try again.');
    expect(ideaflowCallbackErrorMessage({ stateMatched: true, error: 'access_denied' }))
      .toBe('Sign-in was cancelled. You can try again.');
    expect(ideaflowCallbackErrorMessage({ stateMatched: true, error: '<script>x</script>' }))
      .toBe("Ideaflow sign-in didn't work. Please try again.");
  });
});

describe('account choice after explicit sign-out', () => {
  function fakeStorage(): Storage {
    const values = new Map<string, string>();
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
      clear: () => values.clear(),
      key: () => null,
      get length() { return values.size; },
    };
  }
  afterEach(() => vi.unstubAllGlobals());

  it('asks once after an explicit sign-out, then reuses the provider session', () => {
    vi.stubGlobal('window', { localStorage: fakeStorage() });
    expect(takeIdeaflowAccountChoice()).toBe(false);
    markIdeaflowAccountChoice();
    expect(takeIdeaflowAccountChoice()).toBe(true);
    expect(takeIdeaflowAccountChoice()).toBe(false);
  });

  it('is a no-op without browser storage (native)', () => {
    vi.stubGlobal('window', undefined);
    expect(() => markIdeaflowAccountChoice()).not.toThrow();
    expect(takeIdeaflowAccountChoice()).toBe(false);
  });
});

describe('ideaflowStartQuery', () => {
  const base = { state: 's'.repeat(43), nonce: 'n'.repeat(43), codeChallenge: 'c'.repeat(43) };

  it('omits prompt for ordinary sign-in', () => {
    expect(ideaflowStartQuery(base).has('prompt')).toBe(false);
    expect(ideaflowStartQuery({ ...base, selectAccount: false }).has('prompt')).toBe(false);
  });

  it('adds prompt=select_account only for the switch path', () => {
    expect(ideaflowStartQuery({ ...base, selectAccount: true }).getAll('prompt')).toEqual(['select_account']);
  });
});

describe('prepareIdeaflowWebSignIn', () => {
  it('stores state/nonce/verifier and returns the provider URL without navigating', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ url: 'https://id.example/authorize' })));
    const storage = { setItem: vi.fn() };
    const url = await prepareIdeaflowWebSignIn('https://chat.example', { selectAccount: true }, {
      fetchImpl: fetchImpl as unknown as typeof fetch, storage,
    });
    expect(url).toBe('https://id.example/authorize');
    const requested = new URL(String((fetchImpl.mock.calls[0] as unknown[])[0]));
    expect(requested.pathname).toBe('/api/auth/ideaflow/url');
    expect(requested.searchParams.get('prompt')).toBe('select_account');
    const [key, value] = storage.setItem.mock.calls[0];
    expect(key).toBe('openchat_ideaflow_web');
    expect(JSON.parse(value).state).toBe(requested.searchParams.get('state'));
  });

  it('does not store state when the server cannot start sign-in', async () => {
    const storage = { setItem: vi.fn() };
    await expect(prepareIdeaflowWebSignIn('https://chat.example', {}, {
      fetchImpl: (async () => new Response('{}', { status: 503 })) as unknown as typeof fetch, storage,
    })).rejects.toThrow("Couldn't reach Ideaflow");
    expect(storage.setItem).not.toHaveBeenCalled();
  });
});

describe('fetchIdeaflowConfig', () => {
  it('reports enabled and the recovery URL only when enabled', async () => {
    const ok = (body: unknown) => (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;
    expect(await fetchIdeaflowConfig('https://c', ok({ enabled: true, passwordResetUrl: 'https://id/forgot-password' })))
      .toEqual({ status: 'ready', enabled: true, passwordResetUrl: 'https://id/forgot-password' });
    expect(await fetchIdeaflowConfig('https://c', ok({ enabled: false, passwordResetUrl: 'https://x' })))
      .toEqual(disabled);
  });

  it('treats errors and timeouts as disabled so login never stays blank', async () => {
    expect(await fetchIdeaflowConfig('https://c', (async () => { throw new Error('offline'); }) as unknown as typeof fetch))
      .toEqual(disabled);
    const hang = ((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })) as unknown as typeof fetch;
    expect(await fetchIdeaflowConfig('https://c', hang, 5)).toEqual(disabled);
  });
});
