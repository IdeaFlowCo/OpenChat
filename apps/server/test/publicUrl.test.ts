import { describe, expect, it } from 'vitest';
import { chatOriginForHost, chatOriginForRequestHost, ideaflowCallbackForHost, publicChatOrigin } from '../src/config/publicUrl.js';

describe('public OpenChat origins', () => {
  it('generates new links by default and can hold old links through a rollout override', () => {
    expect(publicChatOrigin({})).toBe('https://chat.ideaflow.app');
    expect(publicChatOrigin({ OPENCHAT_URL: 'https://chat.globalbr.ai/' })).toBe('https://chat.globalbr.ai');
  });

  it('keeps OIDC code exchange on the browser host that started it', () => {
    expect(ideaflowCallbackForHost('chat.ideaflow.app')).toBe('https://chat.ideaflow.app/auth/ideaflow/callback');
    expect(ideaflowCallbackForHost('chat.globalbr.ai')).toBe('https://chat.globalbr.ai/auth/ideaflow/callback');
    expect(ideaflowCallbackForHost('attacker.example')).toBeNull();
    expect(chatOriginForHost('chat.globalbr.ai')).toBe('https://chat.globalbr.ai');
    expect(chatOriginForHost('chat.ideaflow.app')).toBe('https://chat.ideaflow.app');
  });

  it('keeps public page links on the requested allowlisted host', () => {
    expect(chatOriginForRequestHost('chat.globalbr.ai')).toBe('https://chat.globalbr.ai');
    expect(chatOriginForRequestHost('chat.ideaflow.app')).toBe('https://chat.ideaflow.app');
    expect(chatOriginForRequestHost('chat.globalbr.ai.attacker.test')).toBe(publicChatOrigin());
  });
});
