import { describe, expect, it } from 'vitest';
import {
  defaultSearchExpiry,
  defaultStoryExpiry,
  projectIntentDraftCard,
  projectStoryForFeed,
  type IntentDraft,
  type OwnedStory,
} from '../src/services/agentSocialLayer.js';

const createdAt = '2026-09-02T12:00:00.000Z';

describe('agent-social defaults and projections', () => {
  it('defaults human Stories to 24 hours and explicit searches to 30 days', () => {
    const now = new Date(createdAt);
    expect(defaultStoryExpiry(now)).toBe('2026-09-03T12:00:00.000Z');
    expect(defaultSearchExpiry(now)).toBe('2026-10-02T12:00:00.000Z');
  });

  it('builds the exact private draft card without source, provenance, or details', () => {
    const draft: IntentDraft = {
      id: 'draft-1', ownerUserId: 'owner', goal: 'Find a Burning Man ticket',
      seeks: ['one ticket'], brings: ['face value'], matchingMode: 'reciprocal',
      openToCollaborators: true, details: 'private friend name', source: 'private iMessage',
      provenance: { messageId: 'secret-message' }, confidence: 0.82, state: 'pending',
      createdAt, updatedAt: createdAt,
    };
    const card = projectIntentDraftCard(draft);
    expect(card).toEqual({
      version: 1,
      draft: {
        id: 'draft-1', goal: 'Find a Burning Man ticket', seeks: ['one ticket'],
        brings: ['face value'], matchingMode: 'reciprocal', openToCollaborators: true,
        confidence: 0.82, state: 'pending', createdAt,
      },
      visibility: { current: 'private', humanVisible: false, agentSearchEnabled: false },
      suggestedActivation: {
        quietSearch: { enabled: true, expiresAt: '2026-10-02T12:00:00.000Z' },
        closeOnConnect: true, audienceLabel: 'Eligible network',
      },
      actions: ['activate_quiet', 'share_story', 'keep_private', 'edit'],
    });
    expect(JSON.stringify(card)).not.toMatch(/friend name|iMessage|secret-message|details|source|provenance/);
  });

  it('projects only safe human Story fields', () => {
    const story: OwnedStory = {
      id: 'story-1', ownerUserId: 'owner', goal: 'Find a ticket', seeks: ['ticket'],
      brings: ['face value'], matchingMode: 'fulfillment', openToCollaborators: false,
      text: 'Looking for one ticket', humanVisible: true, agentSearchEnabled: false,
      status: 'active', audience: { userIds: ['friend'], conversationIds: ['group'] },
      storyExpiresAt: '2026-09-03T12:00:00.000Z', searchExpiresAt: '2026-09-03T12:00:00.000Z',
      intentId: 'private-link', createdAt, updatedAt: createdAt,
    };
    const feed = projectStoryForFeed(story, { id: 'owner', name: 'Jacob' });
    expect(feed.author).toEqual({ id: 'owner', name: 'Jacob' });
    expect(feed.text).toBe('Looking for one ticket');
    expect(JSON.stringify(feed)).not.toMatch(/private-link|audience|intentId|ownerUserId|searchExpiresAt/);
  });

  it('rejects an agent-only object from the human feed projection', () => {
    expect(() => projectStoryForFeed({
      id: 'quiet', ownerUserId: 'owner', goal: 'Quiet ask', seeks: ['help'], brings: [],
      matchingMode: 'fulfillment', openToCollaborators: false, text: null,
      humanVisible: false, agentSearchEnabled: true, status: 'active',
      audience: { userIds: [], conversationIds: [] }, storyExpiresAt: null,
      searchExpiresAt: '2026-10-02T12:00:00.000Z', intentId: 'intent',
      createdAt, updatedAt: createdAt,
    }, { id: 'owner' })).toThrow('not human-visible');
  });
});
