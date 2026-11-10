import { load } from 'cheerio';
import { describe, expect, it } from 'vitest';
import { renderInviteActions } from '../src/services/inviteLanding.js';

describe('public group invitation actions', () => {
  it('offers app open first, web join second, and preserves install and paste paths', () => {
    const $ = load(renderInviteActions('a-token'));
    const actions = $('a.cta').map((_, element) => ({
      label: $(element).text(),
      href: $(element).attr('href'),
    })).get();

    expect(actions).toEqual([
      { label: 'Open in OpenChat', href: 'openchat://invite/a-token' },
      { label: 'Join on the web', href: '/app/?intent=invite&token=a-token' },
      { label: 'Get the iOS app · App Store', href: 'https://apps.apple.com/us/app/openchat-agentic-chat/id6774991932' },
    ]);
    expect($('a.cta-primary')).toHaveLength(1);
    expect($('button').text()).toBe('Copy Invite Link');
    expect($('.cta-tiny').text()).toContain('paste it at sign-in');
  });

  it('encodes tokens in the app and web links', () => {
    const $ = load(renderInviteActions("a'b&c"));
    expect($('a.cta').eq(0).attr('href')).toBe('openchat://invite/a%27b%26c');
    expect($('a.cta').eq(1).attr('href')).toBe('/app/?intent=invite&token=a%27b%26c');
  });
});

describe('invite page link preview', () => {
  it('gives crawlers a neutral preview with no group details, and asks not to be indexed or referred', async () => {
    const { renderInvitePreviewHead } = await import('../src/services/inviteLanding.js');
    const $ = (await import('cheerio')).load(`<html><head>${renderInvitePreviewHead()}</head></html>`);
    expect($('title').text()).toBe('Group invite · OpenChat');
    expect($('meta[property="og:title"]').attr('content')).toBe('You’re invited to a group chat on OpenChat');
    expect($('meta[property="og:description"]').attr('content')).toBe($('meta[name="description"]').attr('content'));
    expect($('meta[name="robots"]').attr('content')).toBe('noindex,nofollow');
    expect($('meta[name="referrer"]').attr('content')).toBe('no-referrer');
  });

  it('names only the chat in a safely escaped preview', async () => {
    const { renderInvitePreviewHead } = await import('../src/services/inviteLanding.js');
    const hostile = 'Garden & "friends" </title><script>alert(1)</script>';
    const head = renderInvitePreviewHead(hostile);
    const $ = load(`<html><head>${head}</head></html>`);
    expect($('title').text()).toBe(`Join ${hostile} on OpenChat`);
    expect($('meta[property="og:title"]').attr('content')).toBe(`Join ${hostile} on OpenChat`);
    expect($('script')).toHaveLength(0);
    expect($('meta[name="description"]').attr('content')).toBe('An invitation to a chat on OpenChat.');
    expect($('meta[property="og:description"]').attr('content')).toBe('An invitation to a chat on OpenChat.');
  });

  it('names the group in the visitor’s tab without letting a title break out of the script', async () => {
    const { inviteTabTitleScript } = await import('../src/services/inviteLanding.js');
    const run = (title: string) => { const document = { title: '' }; new Function('document', inviteTabTitleScript(title))(document); return document.title; };
    expect(run('Garden Club')).toBe('Join Garden Club · OpenChat');
    const hostile = '</script><script>alert(1)</script>"; document.title = "x';
    expect(inviteTabTitleScript(hostile)).not.toContain('</script>');
    expect(run(hostile)).toBe(`Join ${hostile} · OpenChat`);
    expect(run('line break')).toBe('Join line break · OpenChat');
  });
});

describe('invite page without the app installed', () => {
  /** Runs the page script against a minimal page: one primary link, a visibility flag and timers. */
  async function page(token = 'tok/en 1') {
    const { inviteAppFallbackScript } = await import('../src/services/inviteLanding.js');
    const listeners: Record<string, Array<() => void>> = {};
    const timers: Array<() => void> = [];
    const link = { addEventListener: (_: string, fn: () => void) => { (listeners.click ??= []).push(fn); } };
    const document = {
      hidden: false,
      querySelector: (selector: string) => selector === 'a.cta-primary' ? link : null,
      addEventListener: (name: string, fn: () => void) => { (listeners[name] ??= []).push(fn); },
      removeEventListener: (name: string, fn: () => void) => { listeners[name] = (listeners[name] ?? []).filter(f => f !== fn); },
    };
    const location = { href: '/i/x' };
    new Function('document', 'location', 'setTimeout', inviteAppFallbackScript(token))(document, location, (fn: () => void) => { timers.push(fn); });
    return { document, location, tap: () => listeners.click!.forEach(fn => fn()), hide: () => { document.hidden = true; (listeners.visibilitychange ?? []).forEach(fn => fn()); }, elapse: () => timers.splice(0).forEach(fn => fn()) };
  }

  it('continues on the web when tapping Open in OpenChat leaves the page in front', async () => {
    const p = await page();
    p.elapse();
    expect(p.location.href).toBe('/i/x');
    p.tap(); p.elapse();
    expect(p.location.href).toBe('/app/?intent=invite&token=tok%2Fen%201');
  });

  it('stays put when the app took over, even if the visitor comes back later', async () => {
    const p = await page();
    p.tap(); p.hide(); p.document.hidden = false; p.elapse();
    expect(p.location.href).toBe('/i/x');
  });
});
