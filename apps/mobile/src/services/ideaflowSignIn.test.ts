import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchIdeaflowConfig,
  ideaflowCallbackErrorMessage,
  ideaflowStartQuery,
  loginSurface,
  markIdeaflowAccountChoice,
  prepareIdeaflowWebSignIn,
  takeIdeaflowAccountChoice,
  parseIdeaflowNativeCallback,
  startIdeaflowSignIn,
  bytesToBase64Url,
  base64ToBase64Url,
  IDEAFLOW_NATIVE_STATE_PREFIX,
  IDEAFLOW_NATIVE_REDIRECT_URI,
} from './ideaflowSignIn';

const enabled = { status: 'ready', enabled: true, passwordResetUrl: null, autoSignIn: false } as const;
const disabled = { status: 'ready', enabled: false, passwordResetUrl: null, autoSignIn: false } as const;

describe('loginSurface', () => {
  it('shows only the single Sign in with Ideaflow button on web when enabled', () => {
    expect(loginSurface({ platform: 'web', config: enabled })).toEqual({
      pending: false, ideaflow: true, legacy: false, legacyFooter: false, apple: false,
    });
  });

  it('renders no method while the capability check is in flight, on every platform', () => {
    for (const platform of ['web', 'ios', 'android']) {
      expect(loginSurface({ platform, config: { status: 'loading' } })).toEqual({
        pending: true, ideaflow: false, legacy: false, legacyFooter: false, apple: false,
      });
    }
  });

  it('falls back to legacy methods on web when the server disables Ideaflow', () => {
    expect(loginSurface({ platform: 'web', config: disabled })).toEqual({
      pending: false, ideaflow: false, legacy: true, legacyFooter: false, apple: false,
    });
  });

  it('shows Sign in with Ideaflow on native when enabled (code-xbh.14)', () => {
    expect(loginSurface({ platform: 'android', config: enabled })).toEqual({
      pending: false, ideaflow: true, legacy: false, legacyFooter: false, apple: false,
    });
  });

  it('keeps the native Apple button on iOS until Ideaflow ID offers Apple (code-xbh.13)', () => {
    expect(loginSurface({ platform: 'ios', config: enabled })).toEqual({
      pending: false, ideaflow: true, legacy: false, legacyFooter: false, apple: true,
    });
    expect(loginSurface({ platform: 'ios', config: enabled, keepNativeApple: false })).toEqual({
      pending: false, ideaflow: true, legacy: false, legacyFooter: false, apple: false,
    });
  });

  it('restores every legacy native method when the server kill switch is off', () => {
    expect(loginSurface({ platform: 'ios', config: disabled })).toEqual({
      pending: false, ideaflow: false, legacy: true, legacyFooter: true, apple: true,
    });
    expect(loginSurface({ platform: 'android', config: disabled })).toEqual({
      pending: false, ideaflow: false, legacy: true, legacyFooter: true, apple: false,
    });
  });
});

describe('native callback parsing (code-xbh.14)', () => {
  const base = 'openchat://auth/ideaflow/callback';
  it('accepts only the exact state this app generated', () => {
    expect(parseIdeaflowNativeCallback(`${base}?provider=ideaflow&code=abc&state=native-S`, 'native-S'))
      .toEqual({ kind: 'code', code: 'abc' });
    expect(parseIdeaflowNativeCallback(`${base}?provider=ideaflow&code=abc&state=native-X`, 'native-S'))
      .toEqual({ kind: 'error', message: 'That sign-in took too long or was interrupted. Please try again.' });
    expect(parseIdeaflowNativeCallback(`${base}?code=abc`, 'native-S').kind).toBe('error');
  });

  it('maps provider errors to fixed copy and rejects foreign URLs', () => {
    expect(parseIdeaflowNativeCallback(`${base}?error=access_denied&error_description=raw&state=native-S`, 'native-S'))
      .toEqual({ kind: 'error', message: 'Sign-in was cancelled. You can try again.' });
    expect(parseIdeaflowNativeCallback(`${base}?error=server_error&state=native-S`, 'native-S'))
      .toEqual({ kind: 'error', message: "Ideaflow sign-in didn't work. Please try again." });
    expect(parseIdeaflowNativeCallback('https://evil.example/?code=abc&state=native-S', 'native-S').kind).toBe('error');
  });

  it('matches the server bounce prefix and redirect', () => {
    expect(IDEAFLOW_NATIVE_STATE_PREFIX).toBe('native-');
    expect(IDEAFLOW_NATIVE_REDIRECT_URI).toBe('openchat://auth/ideaflow/callback');
  });
});

describe('startIdeaflowSignIn with injected (native) randomness', () => {
  it('prefixes the state, uses the injected PKCE challenge, and returns the secrets', async () => {
    const fetchImpl = vi.fn(async (_input: string) => new Response(JSON.stringify({ url: 'https://id.ideaflow.app/authorize?x=1' }), { status: 200 }));
    let n = 0;
    const result = await startIdeaflowSignIn(
      'https://chat.ideaflow.app',
      { statePrefix: 'native-', selectAccount: true },
      { fetchImpl: fetchImpl as unknown as typeof fetch, random: () => `r${++n}`, challenge: async v => `c-${v}` },
    );
    expect(result).toEqual({
      url: 'https://id.ideaflow.app/authorize?x=1',
      pending: { state: 'native-r1', nonce: 'r2', codeVerifier: 'r3' },
    });
    const requested = new URL(String(fetchImpl.mock.calls[0][0]));
    expect(requested.searchParams.get('state')).toBe('native-r1');
    expect(requested.searchParams.get('code_challenge')).toBe('c-r3');
    expect(requested.searchParams.get('prompt')).toBe('select_account');
  });
});

describe('base64url helpers', () => {
  it('encodes bytes like RFC 4648 base64url without padding', () => {
    const bytes = new Uint8Array([0xfb, 0xff, 0xbf, 0x00, 0x10]);
    expect(bytesToBase64Url(bytes)).toBe(Buffer.from(bytes).toString('base64url'));
    for (let len = 0; len < 50; len++) {
      const random = new Uint8Array(len).map((_, i) => (i * 37 + len * 11) & 255);
      expect(bytesToBase64Url(random)).toBe(Buffer.from(random).toString('base64url'));
    }
  });

  it('converts standard base64 digests to base64url', () => {
    expect(base64ToBase64Url('a+b/c==')).toBe('a-b_c');
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

  it('sends prompt=none only for the silent automatic attempt, never alongside the chooser', () => {
    expect(ideaflowStartQuery({ ...base, silent: true }).getAll('prompt')).toEqual(['none']);
    expect(ideaflowStartQuery({ ...base, silent: true, selectAccount: true }).getAll('prompt')).toEqual(['select_account']);
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

  it('remembers a silent attempt and its return URL with the PKCE secrets', async () => {
    const storage = { setItem: vi.fn() };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ url: 'https://id/authorize' })));
    const url = await prepareIdeaflowWebSignIn('https://chat.example', { silent: true, returnTo: '/app/c/x?y=1#z' }, {
      fetchImpl: fetchImpl as unknown as typeof fetch, storage,
    });
    expect(url).toBe('https://id/authorize');
    const requested = new URL(String((fetchImpl.mock.calls[0] as unknown[])[0]));
    expect(requested.searchParams.getAll('prompt')).toEqual(['none']);
    const stored = JSON.parse(storage.setItem.mock.calls[0][1]);
    expect(stored).toMatchObject({ silent: true, returnTo: '/app/c/x?y=1#z', state: requested.searchParams.get('state') });
    expect(typeof stored.codeVerifier).toBe('string');
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
      .toEqual({ status: 'ready', enabled: true, passwordResetUrl: 'https://id/forgot-password', autoSignIn: false });
    expect(await fetchIdeaflowConfig('https://c', ok({ enabled: false, passwordResetUrl: 'https://x' })))
      .toEqual(disabled);
  });

  it('turns automatic sign-in on only for an explicit true from an enabled server (code-xbh.21.1)', async () => {
    const ok = (body: unknown) => (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;
    expect((await fetchIdeaflowConfig('https://c', ok({ enabled: true, autoSignIn: true }))))
      .toEqual({ status: 'ready', enabled: true, passwordResetUrl: null, autoSignIn: true });
    for (const body of [{ enabled: true }, { enabled: true, autoSignIn: 'true' }, { enabled: false, autoSignIn: true }]) {
      expect(await fetchIdeaflowConfig('https://c', ok(body))).toMatchObject({ status: 'ready', autoSignIn: false });
    }
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
