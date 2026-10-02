import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getMyCard: vi.fn(),
  share: vi.fn(),
  openURL: vi.fn(),
}));

vi.mock('react-native', () => ({
  Share: { share: mocks.share },
  Linking: { openURL: mocks.openURL },
}));
vi.mock('../api/client', () => ({
  api: { getMyCard: mocks.getMyCard },
  addMeCardUrl: (token: string) => `https://chat.globalbr.ai/c/${token}`,
}));

import { cardInviteMessage, currentCardUrl, shareCard, shareCardOnWhatsApp } from './cardSharing';

describe('card invitation handoff', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses the active public card URL and no private profile or contact fields', async () => {
    mocks.getMyCard.mockResolvedValue({
      token: 'ACTIVE', email: 'private@example.test', phone: '+15555550123',
      preview: { name: 'Me' },
    });
    const url = await currentCardUrl();
    expect(url).toBe('https://chat.globalbr.ai/c/ACTIVE');
    expect(cardInviteMessage(url)).toBe(`Connect with me on OpenChat: ${url}`);
    await shareCard(url);
    const payload = mocks.share.mock.calls[0][0];
    expect(payload.message).toContain(url);
    expect(JSON.stringify(payload)).not.toContain('private@example.test');
    expect(JSON.stringify(payload)).not.toContain('+15555550123');
  });

  it('opens a WhatsApp recipient picker with an encoded draft', async () => {
    await shareCardOnWhatsApp('https://chat.globalbr.ai/c/ACTIVE');
    const target = mocks.openURL.mock.calls[0][0] as string;
    expect(target).toBe(`https://wa.me/?text=${encodeURIComponent('Connect with me on OpenChat: https://chat.globalbr.ai/c/ACTIVE')}`);
    expect(target).not.toContain('phone=');
  });
});
