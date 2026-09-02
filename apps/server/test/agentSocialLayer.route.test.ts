import express from 'express';
import jwt from 'jsonwebtoken';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  run: vi.fn(), close: vi.fn(), createIntentDraft: vi.fn(), listIntentDrafts: vi.fn(),
  updateIntentDraft: vi.fn(), activateIntentDraft: vi.fn(), createStory: vi.fn(),
  listStoryFeed: vi.fn(), listOwnedStories: vi.fn(), updateStory: vi.fn(),
  respondToStory: vi.fn(), getSocialPreferences: vi.fn(), updateSocialPreferences: vi.fn(),
  getReviewQueue: vi.fn(),
}));

vi.mock('../src/db.js', () => ({
  getDriver: () => ({ session: () => ({ run: mocks.run, close: mocks.close }) }),
}));

vi.mock('../src/services/agentSocialLayer.js', () => ({
  SocialLayerValidationError: class SocialLayerValidationError extends Error {},
  createIntentDraft: mocks.createIntentDraft, listIntentDrafts: mocks.listIntentDrafts,
  updateIntentDraft: mocks.updateIntentDraft, activateIntentDraft: mocks.activateIntentDraft,
  createStory: mocks.createStory, listStoryFeed: mocks.listStoryFeed,
  listOwnedStories: mocks.listOwnedStories, updateStory: mocks.updateStory,
  respondToStory: mocks.respondToStory, getSocialPreferences: mocks.getSocialPreferences,
  updateSocialPreferences: mocks.updateSocialPreferences, getReviewQueue: mocks.getReviewQueue,
}));

import router from '../src/routes/agentSocialLayer.js';

function bearer(userId = 'social-user'): string {
  return `Bearer ${jwt.sign({ userId, email: `${userId}@example.test` }, 'dev-secret-change-me')}`;
}

describe('agent-social routes', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', router);
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.run.mockResolvedValue({ records: [] });
    mocks.listIntentDrafts.mockResolvedValue([]);
    mocks.listStoryFeed.mockResolvedValue([]);
    mocks.listOwnedStories.mockResolvedValue([]);
    mocks.getReviewQueue.mockResolvedValue({ items: [], hasMore: false });
    mocks.getSocialPreferences.mockResolvedValue({ experienceMode: 'enhanced', networkPaused: false, updatedAt: null });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it('requires authentication on private drafts, feed, preferences, and review', async () => {
    for (const path of ['/api/intent-drafts', '/api/stories/feed', '/api/stories/mine', '/api/social/preferences', '/api/review']) {
      expect((await fetch(`${baseUrl}${path}`)).status).toBe(401);
    }
  });

  it('keeps draft capture structured and owner-scoped', async () => {
    const draft = { id: 'draft', goal: 'Find a ticket', state: 'pending' };
    mocks.createIntentDraft.mockResolvedValue(draft);
    const response = await fetch(`${baseUrl}/api/intent-drafts`, {
      method: 'POST',
      headers: { Authorization: bearer(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: ' Find a ticket ', seeks: ['one ticket'], details: 'private' }),
    });
    expect(response.status).toBe(201);
    expect(mocks.createIntentDraft).toHaveBeenCalledWith('social-user', {
      goal: 'Find a ticket', seeks: ['one ticket'], details: 'private',
    });
    expect(await response.json()).toEqual({ draft });
  });

  it('accepts a text-only direct Story with an explicit audience', async () => {
    mocks.createStory.mockResolvedValue({ story: { id: 'story' }, intent: { id: 'intent' } });
    const body = { text: 'Extra ticket available', audience: { userIds: ['friend'], conversationIds: [] } };
    const response = await fetch(`${baseUrl}/api/stories`, {
      method: 'POST', headers: { Authorization: bearer(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(201);
    expect(mocks.createStory).toHaveBeenCalledWith('social-user', body, { io: undefined });
  });

  it('redacts agent matching context from the human Story feed', async () => {
    mocks.listStoryFeed.mockResolvedValue([{
      id: 'story', author: { id: 'owner', name: 'Owner' }, text: 'The approved human text',
      goal: 'private goal', seeks: ['private seek'], brings: ['private resource'],
      matchingMode: 'reciprocal', openToCollaborators: true,
      storyExpiresAt: '2099-09-03T00:00:00.000Z', createdAt: '2099-09-01T00:00:00.000Z',
    }]);
    const response = await fetch(`${baseUrl}/api/stories/feed`, { headers: { Authorization: bearer() } });
    expect(await response.json()).toEqual({ stories: [{
      id: 'story', author: { id: 'owner', name: 'Owner' }, text: 'The approved human text',
      storyExpiresAt: '2099-09-03T00:00:00.000Z', createdAt: '2099-09-01T00:00:00.000Z',
    }] });
  });

  it('rejects human publication without audience and activation without an enabled channel', async () => {
    const headers = { Authorization: bearer(), 'Content-Type': 'application/json' };
    expect((await fetch(`${baseUrl}/api/stories`, {
      method: 'POST', headers, body: JSON.stringify({ text: 'hello' }),
    })).status).toBe(400);
    expect((await fetch(`${baseUrl}/api/intent-drafts/draft/activate`, {
      method: 'POST', headers, body: JSON.stringify({ quietSearch: { enabled: false } }),
    })).status).toBe(400);
    expect(mocks.createStory).not.toHaveBeenCalled();
    expect(mocks.activateIntentDraft).not.toHaveBeenCalled();
  });

  it('passes separate search and Story expiries through explicit activation', async () => {
    mocks.activateIntentDraft.mockResolvedValue({ draft: { id: 'draft' }, story: { id: 'story' }, intent: { id: 'intent' } });
    const activation = {
      quietSearch: { enabled: true, expiresAt: '2099-10-02T00:00:00.000Z' },
      story: { enabled: true, text: 'Looking for a ticket', expiresAt: '2099-09-03T00:00:00.000Z', audience: { userIds: ['friend'], conversationIds: [] } },
      closeOnConnect: false,
    };
    const response = await fetch(`${baseUrl}/api/intent-drafts/draft/activate`, {
      method: 'POST', headers: { Authorization: bearer(), 'Content-Type': 'application/json' },
      body: JSON.stringify(activation),
    });
    expect(response.status).toBe(201);
    expect(mocks.activateIntentDraft).toHaveBeenCalledWith('social-user', 'draft', activation, { io: undefined });
  });

  it('returns preferences directly and supports pause plus Story expiry updates', async () => {
    const preferences = { experienceMode: 'simple', networkPaused: false, updatedAt: '2099-01-01T00:00:00.000Z' };
    mocks.getSocialPreferences.mockResolvedValue(preferences);
    expect(await (await fetch(`${baseUrl}/api/social/preferences`, { headers: { Authorization: bearer() } })).json())
      .toEqual(preferences);

    mocks.updateStory.mockResolvedValue({ id: 'story', status: 'paused' });
    const storyExpiresAt = '2099-09-03T00:00:00.000Z';
    const response = await fetch(`${baseUrl}/api/stories/story`, {
      method: 'PATCH', headers: { Authorization: bearer(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'paused', storyExpiresAt }),
    });
    expect(response.status).toBe(200);
    expect(mocks.updateStory).toHaveBeenCalledWith('social-user', 'story', { status: 'paused', storyExpiresAt });
  });
});
