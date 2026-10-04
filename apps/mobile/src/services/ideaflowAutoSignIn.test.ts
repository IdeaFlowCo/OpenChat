import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUTO_SIGNIN_COOKIE,
  IDEAFLOW_SIGNED_OUT_KEY,
  autoSignInBlockReason,
  clearIdeaflowSignedOut,
  markIdeaflowSignedOut,
  readBrowserEnvironment,
  currentReturnPath,
  isAuthCallbackSearch,
  markAutoSignInAttempted,
  readCookie,
  resolveIdeaflowWebCallback,
  safeReturnPath,
  type AutoSignInEnvironment,
} from './ideaflowAutoSignIn';

const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const HEADLESS = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36';
const SAFARI_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const CHROME_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1';
const FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:131.0) Gecko/20100101 Firefox/131.0';

const base: AutoSignInEnvironment = {
  platform: 'web',
  userAgent: CHROME,
  cookie: 'other=1',
  cookieEnabled: true,
  prerendering: false,
  inFrame: false,
  nativeBridge: false,
  initialSearch: '',
  explicitlySignedOut: false,
};

describe('autoSignInBlockReason', () => {
  it.each([CHROME, HEADLESS, SAFARI_IOS, CHROME_IOS, FIREFOX])('allows an ordinary signed-out browser: %s', ua => {
    expect(autoSignInBlockReason({ ...base, userAgent: ua })).toBeNull();
  });

  it.each([
    ['native iOS', { platform: 'ios' }, 'not-web'],
    ['native Android', { platform: 'android' }, 'not-web'],
    ['a callback load', { initialSearch: '?provider=ideaflow&error=login_required&state=s' }, 'callback'],
    ['a Google callback load', { initialSearch: '?code=c&state=s' }, 'callback'],
    ['an earlier attempt this session', { cookie: `a=1; ${AUTO_SIGNIN_COOKIE}=1` }, 'already-attempted'],
    ['an explicit sign-out', { explicitlySignedOut: true }, 'signed-out'],
    ['prerender', { prerendering: true }, 'prerender'],
    ['a frame', { inFrame: true }, 'frame'],
    ['blocked cookies', { cookieEnabled: false }, 'no-cookies'],
    ['a native shell bridge', { nativeBridge: true }, 'embedded'],
  ] as const)('blocks %s', (_label, patch, reason) => {
    expect(autoSignInBlockReason({ ...base, ...patch })).toBe(reason);
  });

  it.each([
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141 Safari/537.36 Discordbot/2.0',
    'curl/8.7.1',
    'python-requests/2.32',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0) Safari/537.36',
  ])('blocks crawlers and scripted clients: %s', ua => {
    expect(autoSignInBlockReason({ ...base, userAgent: ua })).toBe('bot');
  });

  it.each([
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/480.0]',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0',
    'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) OpenChat/1.0 Chrome/130 Electron/33.0 Safari/537.36',
    // OpenChat desktop (Tauri / WKWebView on macOS) and bare iOS webviews: no Safari/ token.
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  ])('blocks embedded webviews and in-app browsers: %s', ua => {
    expect(autoSignInBlockReason({ ...base, userAgent: ua })).toBe('embedded');
  });
});

describe('cookies', () => {
  it('reads one cookie by exact name', () => {
    expect(readCookie(`x=1; ${AUTO_SIGNIN_COOKIE}=1; y=2`, AUTO_SIGNIN_COOKIE)).toBe('1');
    expect(readCookie(`x${AUTO_SIGNIN_COOKIE}=1`, AUTO_SIGNIN_COOKIE)).toBeNull();
    expect(readCookie('', AUTO_SIGNIN_COOKIE)).toBeNull();
  });

  it('sets a Secure, Lax, path-wide session cookie and confirms it stuck', () => {
    const written: string[] = [];
    const jar = new Map<string, string>();
    const doc = {
      get cookie() { return [...jar].map(([k, v]) => `${k}=${v}`).join('; '); },
      set cookie(value: string) {
        written.push(value);
        const [pair] = value.split(';');
        const [k, v] = pair.split('=');
        jar.set(k.trim(), v.trim());
      },
    };
    expect(markAutoSignInAttempted(doc)).toBe(true);
    expect(written).toEqual([`${AUTO_SIGNIN_COOKIE}=1; Path=/; Secure; SameSite=Lax`]);
    expect(written[0]).not.toMatch(/expires|max-age/i);
  });

  it('reports failure when the browser drops the cookie, so no redirect loop can start', () => {
    const doc = { get cookie() { return ''; }, set cookie(_v: string) { /* blocked */ } };
    expect(markAutoSignInAttempted(doc)).toBe(false);
    expect(markAutoSignInAttempted(undefined)).toBe(false);
  });
});

describe('return path', () => {
  it('keeps path, query and hash but drops OAuth response fields', () => {
    expect(currentReturnPath({ pathname: '/app/c/abc', search: '?x=1&code=c&state=s&provider=ideaflow', hash: '#m-9' }))
      .toBe('/app/c/abc?x=1#m-9');
    expect(currentReturnPath({ pathname: '/app/', search: '', hash: '' })).toBe('/app/');
  });

  it.each([
    ['/app/c/abc?x=1#m-9', '/app/c/abc?x=1#m-9'],
    ['/i/tok', '/i/tok'],
    ['//evil.example/x', null],
    ['/\\evil.example', null],
    ['https://evil.example/app/', null],
    ['javascript:alert(1)', null],
    ['app/relative', null],
    ['/app/\nx', null],
    ['', null],
    [42, null],
  ] as const)('safeReturnPath(%j) -> %j', (raw, expected) => {
    expect(safeReturnPath(raw)).toBe(expected);
  });

  it('recognises callback query strings', () => {
    expect(isAuthCallbackSearch('?provider=ideaflow&code=c')).toBe(true);
    expect(isAuthCallbackSearch('?error=login_required')).toBe(true);
    expect(isAuthCallbackSearch('?x=1')).toBe(false);
    expect(isAuthCallbackSearch('')).toBe(false);
  });
});

describe('resolveIdeaflowWebCallback', () => {
  const silent = JSON.stringify({ state: 'S', nonce: 'N', codeVerifier: 'V', silent: true, returnTo: '/app/c/abc?x=1#h' });
  const explicit = JSON.stringify({ state: 'S', nonce: 'N', codeVerifier: 'V', returnTo: '/app/' });

  it('ignores non-Ideaflow loads', () => {
    expect(resolveIdeaflowWebCallback('?code=c&state=S', silent)).toEqual({ kind: 'none' });
  });

  it.each(['login_required', 'consent_required', 'interaction_required', 'server_error', 'access_denied'])(
    'returns quietly to the original URL when a silent attempt gets %s',
    error => {
      expect(resolveIdeaflowWebCallback(`?provider=ideaflow&error=${error}&state=S&iss=x`, silent))
        .toEqual({ kind: 'quiet', returnTo: '/app/c/abc?x=1#h' });
    },
  );

  it('redeems a silent code only for the stored state and keeps the return URL', () => {
    expect(resolveIdeaflowWebCallback('?provider=ideaflow&code=C&state=S', silent)).toEqual({
      kind: 'exchange', code: 'C', codeVerifier: 'V', nonce: 'N', silent: true, returnTo: '/app/c/abc?x=1#h',
    });
    expect(resolveIdeaflowWebCallback('?provider=ideaflow&code=C&state=OTHER', silent))
      .toEqual({ kind: 'quiet', returnTo: '/app/c/abc?x=1#h' });
  });

  it('treats an error with unknown or missing state as a quiet signed-out return', () => {
    expect(resolveIdeaflowWebCallback('?provider=ideaflow&error=login_required&state=S', null))
      .toEqual({ kind: 'quiet', returnTo: null });
    expect(resolveIdeaflowWebCallback('?provider=ideaflow&error=login_required', 'not json'))
      .toEqual({ kind: 'quiet', returnTo: null });
  });

  it('keeps fixed error copy for the explicit flow', () => {
    expect(resolveIdeaflowWebCallback('?provider=ideaflow&error=access_denied&state=S', explicit))
      .toEqual({ kind: 'error', returnTo: '/app/', stateMatched: true, error: 'access_denied' });
    expect(resolveIdeaflowWebCallback('?provider=ideaflow&code=C&state=S', null))
      .toEqual({ kind: 'error', returnTo: null, stateMatched: false, error: null });
    expect(resolveIdeaflowWebCallback('?provider=ideaflow&code=C&state=S', explicit)).toMatchObject({
      kind: 'exchange', silent: false,
    });
  });

  it('never restores an off-site return URL', () => {
    const evil = JSON.stringify({ state: 'S', nonce: 'N', codeVerifier: 'V', silent: true, returnTo: '//evil.example/' });
    expect(resolveIdeaflowWebCallback('?provider=ideaflow&error=login_required&state=S', evil))
      .toEqual({ kind: 'quiet', returnTo: null });
  });
});

describe('explicit sign-out marker', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('blocks automatic sign-in after an explicit sign-out until the next session is established', () => {
    const local = new Map<string, string>();
    let cookie = '';
    const win = {
      localStorage: {
        getItem: (k: string) => local.get(k) ?? null,
        setItem: (k: string, v: string) => { local.set(k, v); },
        removeItem: (k: string) => { local.delete(k); },
      },
      location: { search: '' },
    } as Record<string, unknown>;
    win.top = win; win.self = win;
    vi.stubGlobal('window', win);
    vi.stubGlobal('navigator', { userAgent: CHROME, cookieEnabled: true });
    vi.stubGlobal('document', {
      get cookie() { return cookie; },
      set cookie(v: string) { cookie = v.split(';')[0]; },
    });

    expect(autoSignInBlockReason(readBrowserEnvironment('web', ''))).toBeNull();
    markIdeaflowSignedOut();
    expect(local.get(IDEAFLOW_SIGNED_OUT_KEY)).toBe('1');
    cookie = ''; // a new browser session: the session cookie is gone, the marker is not
    expect(autoSignInBlockReason(readBrowserEnvironment('web', ''))).toBe('signed-out');
    clearIdeaflowSignedOut();
    expect(autoSignInBlockReason(readBrowserEnvironment('web', ''))).toBeNull();
  });

  it('is a harmless no-op without browser storage (native)', () => {
    vi.stubGlobal('window', {});
    expect(() => { markIdeaflowSignedOut(); clearIdeaflowSignedOut(); }).not.toThrow();
  });
});
