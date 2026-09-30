import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CARD_SETTINGS,
  generateCardToken,
  isWellFormedCardToken,
  parseCardSettingsPatch,
  projectCardForStranger,
  type CardOwnerRecord,
} from '../src/services/addMeCard.js';
import { renderCardPage } from '../src/services/addMeCardPage.js';
import { renderCardVcard } from '../src/services/addMeCardVcard.js';

// An owner record with every private field the graph might hand back.
const owner: CardOwnerRecord = {
  id: 'user-internal-id-123',
  email: 'jacob@example.com',
  name: 'Jacob Cole',
  avatarUrl: 'https://cdn.example.com/a.png',
  isBot: false,
  profileStatusText: 'At the conference',
  profileStatusEmoji: '🎤',
  presenceStatus: 'online',
  lastSeenAt: '2026-09-25T10:00:00Z',
  discoveryMode: 'hidden',
  phoneNumberHash: 'abc',
};

describe('AddMe card consent projection', () => {
  it('shows the configured default fields (avatar, headline, linkedIn, x)', () => {
    // Owner has an avatarUrl and showAvatar is true by default now.
    expect(projectCardForStranger(owner, DEFAULT_CARD_SETTINGS)).toEqual({
      name: 'Jacob Cole',
      isBot: false,
      headline: null,
      avatarUrl: 'https://cdn.example.com/a.png',
      status: null,
      linkedIn: null,
      x: null,
      link: null,
    });
  });

  it('never exposes id, email, presence, discovery, or phone fields, whatever is opted in', () => {
    const card = projectCardForStranger(owner, {
      showAvatar: true,
      showStatus: true,
      showHeadline: true,
      headline: 'Founder',
      showLinkedIn: true,
      linkedIn: 'https://linkedin.com/in/jacob',
      showX: true,
      x: 'https://x.com/jacob',
      showLink: true,
      link: 'https://example.com',
    });
    expect(Object.keys(card).sort()).toEqual(['avatarUrl', 'headline', 'isBot', 'link', 'linkedIn', 'name', 'status', 'x']);
    const serialized = JSON.stringify(card);
    expect(serialized).not.toContain('user-internal-id-123');
    expect(serialized).not.toContain('jacob@example.com');
    expect(serialized).not.toContain('online');
    expect(serialized).not.toContain('hidden');
  });

  it('shows the avatar only when opted in', () => {
    expect(projectCardForStranger(owner, { ...DEFAULT_CARD_SETTINGS, showAvatar: true }).avatarUrl)
      .toBe('https://cdn.example.com/a.png');
    expect(projectCardForStranger(owner, { ...DEFAULT_CARD_SETTINGS, showAvatar: false }).avatarUrl).toBeNull();
  });

  it('shows the status only when opted in and present', () => {
    expect(projectCardForStranger(owner, { ...DEFAULT_CARD_SETTINGS, showStatus: true }).status)
      .toEqual({ text: 'At the conference', emoji: '🎤' });
    expect(projectCardForStranger(owner, { ...DEFAULT_CARD_SETTINGS, showStatus: false }).status).toBeNull();
    expect(projectCardForStranger(
      { ...owner, profileStatusText: null, profileStatusEmoji: '  ' },
      { ...DEFAULT_CARD_SETTINGS, showStatus: true },
    ).status).toBeNull();
  });

  it('never renders an email-shaped name, headline, or unsafe link', () => {
    const card = projectCardForStranger(
      { ...owner, name: 'jacob@example.com' },
      { ...DEFAULT_CARD_SETTINGS, showHeadline: true, headline: 'mail me at jacob@example.com', showLink: true, link: 'javascript:alert(1)' },
    );
    expect(card.name).toBe('OpenChat member');
    expect(card.headline).toBeNull();
    expect(card.link).toBeNull();
  });

  it('rejects control characters in owner-published links', () => {
    expect(parseCardSettingsPatch({ link: 'https://example.com/\r\nTEL:123' }).ok).toBe(false);
    expect(projectCardForStranger(owner, {
      ...DEFAULT_CARD_SETTINGS, showLink: true, link: 'https://example.com/\nTEL:123',
    }).link).toBeNull();
  });

  it('treats blank card-only fields as not shared', () => {
    const card = projectCardForStranger(owner, { ...DEFAULT_CARD_SETTINGS, headline: '   ', link: '' });
    expect(card.headline).toBeNull();
    expect(card.link).toBeNull();
  });
});

describe('AddMe card settings patch', () => {
  it('accepts opt-in toggles and normalises links', () => {
    expect(parseCardSettingsPatch({ showAvatar: true, link: 'linkedin.com/in/jacob', headline: ' Founder ', x: 'x.com/jacob' })).toEqual({
      ok: true,
      patch: { showAvatar: true, link: 'https://linkedin.com/in/jacob', headline: 'Founder', x: 'https://x.com/jacob' },
    });
  });

  it('clears fields with empty strings or null', () => {
    expect(parseCardSettingsPatch({ headline: '', link: null, x: '', linkedIn: null })).toEqual({
      ok: true,
      patch: { headline: null, link: null, x: null, linkedIn: null },
    });
  });

  it('rejects bad input', () => {
    expect(parseCardSettingsPatch({ showAvatar: 'yes' }).ok).toBe(false);
    expect(parseCardSettingsPatch({ headline: 'x'.repeat(81) }).ok).toBe(false);
    expect(parseCardSettingsPatch({ headline: 'a@b.co' }).ok).toBe(false);
    expect(parseCardSettingsPatch({ link: 'https://user:pw@example.com' }).ok).toBe(false);
    expect(parseCardSettingsPatch(null).ok).toBe(false);
  });

  it('ignores keys that are not card settings', () => {
    expect(parseCardSettingsPatch({ email: 'x@y.z', id: 'other' })).toEqual({ ok: true, patch: {} });
  });
});

describe('AddMe card token', () => {
  it('is long, random, URL-safe, and validated strictly', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateCardToken()));
    expect(tokens.size).toBe(200);
    for (const token of tokens) expect(isWellFormedCardToken(token)).toBe(true);
    expect(isWellFormedCardToken('short')).toBe(false);
    expect(isWellFormedCardToken('a'.repeat(23) + '/')).toBe(false);
    expect(isWellFormedCardToken('a'.repeat(24) + '\n')).toBe(false);
    expect(isWellFormedCardToken(undefined)).toBe(false);
  });
});

describe('AddMe card page', () => {
  it('escapes owner-controlled text and omits fields that are not shared', () => {
    const html = renderCardPage(
      projectCardForStranger({ ...owner, name: '<script>x</script>' }, DEFAULT_CARD_SETTINGS),
      generateCardToken(),
    );
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('At the conference');
    expect(html).not.toContain('user-internal-id-123');
    expect(html).toContain('/app/?intent=card&token=');
    expect(html).toContain('Request to be friends with &lt;script&gt;x&lt;/script&gt;');
    expect(html).toContain('/contact.vcf">Save contact</a>');
  });
});

describe('AddMe vCard', () => {
  it.each([null, '', '\u0000\u0001', 'private@example.test'])('uses a neutral minimum name for %j', name => {
    const card = projectCardForStranger({ name }, DEFAULT_CARD_SETTINGS);
    expect(renderCardVcard(card, 'AbCdEfGhIjKlMnOpQrStUvWx')).toContain('FN:OpenChat member\r\n');
  });

  it('has a useful minimum card with UTF-8 text and CRLF lines', () => {
    const card = projectCardForStranger({ name: '山田 太郎 ✨', email: 'hidden@example.test' }, DEFAULT_CARD_SETTINGS);
    const vcard = renderCardVcard(card, 'AbCdEfGhIjKlMnOpQrStUvWx');
    expect(vcard).toBe('BEGIN:VCARD\r\nVERSION:3.0\r\nN:;山田 太郎 ✨;;;\r\nFN:山田 太郎 ✨\r\nURL:https://chat.ideaflow.app/c/AbCdEfGhIjKlMnOpQrStUvWx\r\nEND:VCARD\r\n');
    expect(vcard).not.toContain('hidden@example.test');
  });

  it('escapes malicious line breaks, slashes, commas, and semicolons', () => {
    const card = projectCardForStranger(
      { name: 'Jo\\hn, Doe;\r\nTEL:+12345' },
      { ...DEFAULT_CARD_SETTINGS, headline: 'Hello\nTEL:+99999' },
    );
    const vcard = renderCardVcard(card, 'AbCdEfGhIjKlMnOpQrStUvWx');
    expect(vcard).toContain('FN:Jo\\\\hn\\, Doe\\;\\nTEL:+12345\r\n');
    expect(vcard).toContain('NOTE:Hello\\nTEL:+99999\r\n');
    expect(vcard).not.toMatch(/\r\n(?:TEL|EMAIL):/);
  });

  it('folds long Unicode values by UTF-8 bytes without splitting a character', () => {
    const name = '山😀e\u0301'.repeat(40);
    const card = projectCardForStranger({ name }, DEFAULT_CARD_SETTINGS);
    const vcard = renderCardVcard(card, 'AbCdEfGhIjKlMnOpQrStUvWx');
    for (const line of vcard.trimEnd().split('\r\n')) {
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
    }
    expect(vcard.replace(/\r\n /g, '')).toContain(`FN:${name}\r\n`);
    expect(Buffer.from(vcard).toString('utf8')).toBe(vcard);
  });

  it.each(['\r\n', '\r', '\n', '\u0085', '\u2028', '\u2029'])('escapes line separator %j before an injected property', separator => {
    const card = projectCardForStranger({ name: `Name${separator}TEL:123` }, {
      ...DEFAULT_CARD_SETTINGS, headline: `Hello${separator}END:VCARD`,
    });
    const vcard = renderCardVcard(card, 'AbCdEfGhIjKlMnOpQrStUvWx');
    const properties = vcard.replace(/\r\n /g, '').trimEnd().split(/\r\n|[\r\n\u0085\u2028\u2029]/);
    expect(properties.map(line => line.split(':')[0])).toEqual(['BEGIN', 'VERSION', 'N', 'FN', 'NOTE', 'URL', 'END']);
    expect(properties).toContain('FN:Name\\nTEL:123');
    expect(properties).toContain('NOTE:Hello\\nEND:VCARD');
  });

  it('keeps every disabled field and private owner property out of the export', () => {
    const card = projectCardForStranger({ ...owner, importedContacts: ['private contact'], relationships: ['private edge'] }, {
      ...DEFAULT_CARD_SETTINGS, showHeadline: false, headline: 'private headline',
      showLinkedIn: false, linkedIn: 'https://example.com/private-linkedin',
      showX: false, x: 'https://example.com/private-x',
      showLink: false, link: 'https://example.com/private-link',
    });
    expect(renderCardVcard(card, 'AbCdEfGhIjKlMnOpQrStUvWx')).toBe(
      'BEGIN:VCARD\r\nVERSION:3.0\r\nN:;Jacob Cole;;;\r\nFN:Jacob Cole\r\nURL:https://chat.ideaflow.app/c/AbCdEfGhIjKlMnOpQrStUvWx\r\nEND:VCARD\r\n',
    );
  });
});
