import { describe, expect, it, vi } from 'vitest';
import {
  fetchIdeaflowConfig,
  ideaflowStartQuery,
  loginSurface,
  prepareIdeaflowWebSignIn,
} from './ideaflowSignIn';

const enabled = { status: 'ready', enabled: true, passwordResetUrl: null } as const;
const disabled = { status: 'ready', enabled: false, passwordResetUrl: null } as const;

describe('loginSurface', () => {
  it('shows only Ideaflow (plus secondary links) on web when enabled', () => {
    expect(loginSurface({ isWeb: true, config: enabled, showOtherOptions: false })).toEqual({
      pending: false, ideaflow: true, switchAccount: true, otherOptionsToggle: true, legacy: false, legacyFooter: false,
    });
    expect(loginSurface({ isWeb: true, config: enabled, showOtherOptions: true }).legacy).toBe(true);
  });

  it('renders no method while the web capability check is in flight', () => {
    expect(loginSurface({ isWeb: true, config: { status: 'loading' }, showOtherOptions: true })).toEqual({
      pending: true, ideaflow: false, switchAccount: false, otherOptionsToggle: false, legacy: false, legacyFooter: false,
    });
  });

  it('falls back to legacy methods on web when the server disables Ideaflow', () => {
    expect(loginSurface({ isWeb: true, config: disabled, showOtherOptions: false })).toMatchObject({
      ideaflow: false, otherOptionsToggle: false, legacy: true, legacyFooter: false,
    });
  });

  it('leaves native unchanged regardless of config', () => {
    for (const config of [enabled, disabled, { status: 'loading' } as const]) {
      expect(loginSurface({ isWeb: false, config, showOtherOptions: false })).toEqual({
        pending: false, ideaflow: false, switchAccount: false, otherOptionsToggle: false, legacy: true, legacyFooter: true,
      });
    }
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
    })).rejects.toThrow('503');
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
