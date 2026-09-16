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

async function approvedPost(baseUrl: string, path: string, body: Record<string, unknown>) {
  const headers = { Authorization: bearer(), 'Content-Type': 'application/json' };
  const preview = await fetch(`${baseUrl}${path}`, {
    method: 'POST', headers, body: JSON.stringify({ ...body, confirm: false }),
  });
  const approval = await preview.json() as { approvalGrant: string };
  return fetch(`${baseUrl}${path}`, {
    method: 'POST', headers,
    body: JSON.stringify({ ...body, confirm: true, approvalGrant: approval.approvalGrant }),
  });
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
    const body = {
      text: 'Extra ticket available', audience: { userIds: ['friend'], conversationIds: [] },
      storyExpiresAt: '2099-09-03T00:00:00.000Z',
    };
    const response = await approvedPost(baseUrl, '/api/stories', body);
    expect(response.status).toBe(201);
    expect(mocks.createStory).toHaveBeenCalledWith('social-user', {
      text: body.text,
      audience: body.audience,
      storyExpiresAt: body.storyExpiresAt,
    }, { confirmed: true, io: undefined });
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
      method: 'POST', headers, body: JSON.stringify({ confirm: true, text: 'hello' }),
    })).status).toBe(400);
    expect((await fetch(`${baseUrl}/api/intent-drafts/draft/activate`, {
      method: 'POST', headers, body: JSON.stringify({ confirm: true, quietSearch: { enabled: false } }),
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
    const response = await approvedPost(baseUrl, '/api/intent-drafts/draft/activate', activation);
    expect(response.status).toBe(201);
    expect(mocks.activateIntentDraft).toHaveBeenCalledWith('social-user', 'draft', {
      quietSearch: activation.quietSearch,
      story: activation.story,
      closeOnConnect: activation.closeOnConnect,
    }, { confirmed: true, io: undefined });
  });

  it('requires payload-bound single-use approval for activation and Story publication', async () => {
    const headers = { Authorization: bearer(), 'Content-Type': 'application/json' };
    const storyPreview = await fetch(`${baseUrl}/api/stories`, {
      method: 'POST', headers,
      body: JSON.stringify({
        text: 'Extra ticket', audience: { userIds: ['friend'], conversationIds: [] },
        storyExpiresAt: '2099-09-03T00:00:00.000Z',
      }),
    });
    const storyApproval = await storyPreview.json() as { approvalGrant: string };
    const changedStory = await fetch(`${baseUrl}/api/stories`, {
      method: 'POST', headers,
      body: JSON.stringify({
        confirm: true,
        approvalGrant: storyApproval.approvalGrant,
        text: 'Changed after approval',
        audience: { userIds: ['friend'], conversationIds: [] },
        storyExpiresAt: '2099-09-03T00:00:00.000Z',
      }),
    });
    const replay = await fetch(`${baseUrl}/api/stories`, {
      method: 'POST', headers,
      body: JSON.stringify({
        confirm: true,
        approvalGrant: storyApproval.approvalGrant,
        text: 'Extra ticket',
        audience: { userIds: ['friend'], conversationIds: [] },
        storyExpiresAt: '2099-09-03T00:00:00.000Z',
      }),
    });
    const activation = await fetch(`${baseUrl}/api/intent-drafts/draft/activate`, {
      method: 'POST', headers,
      body: JSON.stringify({
        confirm: true,
        quietSearch: { enabled: true, expiresAt: '2099-10-02T00:00:00.000Z' },
      }),
    });
    expect(storyPreview.status).toBe(200);
    expect(changedStory.status).toBe(409);
    expect(replay.status).toBe(409);
    expect(activation.status).toBe(409);
    expect(mocks.createStory).not.toHaveBeenCalled();
    expect(mocks.activateIntentDraft).not.toHaveBeenCalled();
  });

  it('binds Story-response approval to the exact message and approving user', async () => {
    const body = { message: 'I can help with that ticket' };
    mocks.respondToStory.mockResolvedValue({ conversationId: 'conversation' });
    const headers = { Authorization: bearer(), 'Content-Type': 'application/json' };
    const preview = await fetch(`${baseUrl}/api/stories/story/respond`, {
      method: 'POST', headers, body: JSON.stringify(body),
    });
    const approval = await preview.json() as {
      approvalRequired: boolean;
      approvalGrant: string;
      payload: { storyId: string; message: string };
    };

    expect(preview.status).toBe(200);
    expect(approval).toMatchObject({
      approvalRequired: true,
      payload: { storyId: 'story', message: body.message },
    });

    const wrongActor = await fetch(`${baseUrl}/api/stories/story/respond`, {
      method: 'POST',
      headers: { Authorization: bearer('other-user'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, confirm: true, approvalGrant: approval.approvalGrant }),
    });
    expect(wrongActor.status).toBe(409);

    const approved = await approvedPost(baseUrl, '/api/stories/story/respond', body);
    expect(approved.status).toBe(201);
    expect(mocks.respondToStory).toHaveBeenCalledWith('social-user', 'story', body.message, undefined);
  });

  it('preserves explicit direction for a text-only quiet search', async () => {
    mocks.createStory.mockResolvedValue({ story: { id: 'story' }, intent: { id: 'intent' } });
    const response = await approvedPost(baseUrl, '/api/stories', {
        kind: 'ask',
        text: 'I need a ticket',
        audience: { userIds: ['friend'], conversationIds: [] },
        storyExpiresAt: '2099-09-03T00:00:00.000Z',
        quietSearch: { enabled: true, expiresAt: '2099-10-02T00:00:00.000Z' },
    });
    expect(response.status).toBe(201);
    expect(mocks.createStory).toHaveBeenCalledWith('social-user', expect.objectContaining({
      kind: 'ask',
      quietSearch: { enabled: true, expiresAt: '2099-10-02T00:00:00.000Z' },
    }), { confirmed: true, io: undefined });
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
