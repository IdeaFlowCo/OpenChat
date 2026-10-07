import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
const html = readFileSync(new URL('../src/landing.html', import.meta.url), 'utf8');
const script = html.match(/<script id="landing-session">([\s\S]*?)<\/script>/)![1];
const settle = () => new Promise(resolve => setImmediate(resolve));
function setup(initial: string | null, fetch = vi.fn()) {
  let token = initial;
  const nav = { textContent: 'Open OpenChat' };
  const status = { textContent: '', hidden: true };
  const events: Record<string, (event?: unknown) => void> = {};
  const storage = { getItem: vi.fn(() => token) };
  runInNewContext(script, {
    document: { getElementById: (id: string) => id === 'nav-signin' ? nav : status },
    window: { addEventListener: (name: string, fn: () => void) => { events[name] = fn; } },
    localStorage: storage, fetch,
  });
  return { nav, status, events, storage, fetch, setToken: (value: string | null) => { token = value; } };
}
describe('landing page session', () => {
  it('offers sign in without a local session', () => {
    const page = setup(null);
    expect(page.nav.textContent).toBe('Sign in');
    expect(page.fetch).not.toHaveBeenCalled();
  });
  it('verifies the account and renders its name as text', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'user', name: '<b>Jacob</b>' }) });
    const page = setup('session', fetch);
    await settle();
    expect(fetch).toHaveBeenCalledWith('/api/auth/me', { headers: { Authorization: 'Bearer session' }, cache: 'no-store' });
    expect(page.nav.textContent).toBe('Open OpenChat');
    expect(page.status).toEqual({ textContent: 'Signed in as <b>Jacob</b>', hidden: false });
  });
  it('rejects stale local session state', async () => {
    const page = setup('expired', vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    await settle();
    expect(page.nav.textContent).toBe('Sign in');
    expect(page.status.hidden).toBe(true);
  });
  it('does not label network failure as sign-out', async () => {
    const page = setup('session', vi.fn().mockRejectedValue(new Error('offline')));
    await settle();
    expect(page.nav.textContent).toBe('Open OpenChat');
    expect(page.status.hidden).toBe(true);
  });
  it('ignores a late response after cross-tab sign-out', async () => {
    let resolve!: (value: unknown) => void;
    const page = setup('session', vi.fn().mockReturnValue(new Promise(done => { resolve = done; })));
    page.setToken(null);
    page.events.storage({ key: 'openchat_token' });
    resolve({ ok: true, json: async () => ({ id: 'old', name: 'Old account' }) });
    await settle();
    expect(page.nav.textContent).toBe('Sign in');
    expect(page.status.hidden).toBe(true);
  });
  it('rechecks on return and tolerates blocked storage', async () => {
    const page = setup(null, vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'user' }) }));
    page.setToken('new-session');
    page.events.pageshow();
    await settle();
    expect(page.status.textContent).toBe('You’re signed in.');
    page.storage.getItem.mockImplementation(() => { throw new Error('blocked'); });
    page.events.focus();
    expect(page.nav.textContent).toBe('Sign in');
  });
});
