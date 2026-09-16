import { describe, expect, it } from 'vitest';
import { activateIntentDraft, createStory } from '../src/services/agentSocialLayer.js';

describe('agent-social consent boundary', () => {
  it('rejects draft activation before touching persistence without shared confirmation', async () => {
    await expect(activateIntentDraft('owner', 'draft', {
      quietSearch: { enabled: true },
    }, {} as never)).rejects.toThrow('Explicit approval is required');
  });

  it('rejects Story publication before touching persistence without shared confirmation', async () => {
    await expect(createStory('owner', {
      text: 'Extra ticket',
      audience: { userIds: ['friend'], conversationIds: [] },
    }, {} as never)).rejects.toThrow('Explicit approval is required');
  });

  it('requires explicit direction for text-only quiet search before touching persistence', async () => {
    await expect(createStory('owner', {
      text: 'Ticket',
      audience: { userIds: ['friend'], conversationIds: [] },
      quietSearch: { enabled: true },
    }, { confirmed: true })).rejects.toThrow('kind is required');
  });
});
