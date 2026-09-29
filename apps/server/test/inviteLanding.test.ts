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
