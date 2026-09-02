import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import neo4j, { type Driver } from 'neo4j-driver';

const uri = process.env.NEO4J_TEST_URI;
const user = process.env.NEO4J_TEST_USER;
const password = process.env.NEO4J_TEST_PASSWORD;
const integration = uri && user && password ? describe.sequential : describe.skip;

integration('agent-social private capture and Story privacy', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const [owner, selected, outsider, groupMember, quietPeer] = [
    'social-owner', 'social-selected', 'social-outsider', 'social-member', 'social-peer',
  ].map((prefix) => `${prefix}-${suffix}`) as [string, string, string, string, string];
  const userIds = [owner, selected, outsider, groupMember, quietPeer];
  const conversationId = `social-conversation-${suffix}`;
  let driver: Driver;
  let social: typeof import('../src/services/agentSocialLayer.js');
  let network: typeof import('../src/services/agentNetwork.js');
  let database: typeof import('../src/db.js');

  beforeAll(async () => {
    process.env.NEO4J_URI = uri!;
    process.env.NEO4J_USER = user!;
    process.env.NEO4J_PASSWORD = password!;
    database = await import('../src/db.js');
    social = await import('../src/services/agentSocialLayer.js');
    network = await import('../src/services/agentNetwork.js');
    await database.initDatabase();
    await network.ensureAgentIntentIndexes();
    await social.ensureAgentSocialLayerIndexes();
    driver = neo4j.driver(uri!, neo4j.auth.basic(user!, password!));
    const session = driver.session();
    try {
      await session.run(
        `UNWIND $userIds AS userId CREATE (:User {id: userId, name: userId, email: userId + '@example.test'})`,
        { userIds },
      );
      await session.run(
        `MATCH (owner:User {id: $owner}), (member:User {id: $member})
         CREATE (conversation:Conversation {id: $conversationId, type: 'group', createdAt: datetime()})
         CREATE (owner)-[:PARTICIPATES_IN {role:'owner'}]->(conversation)
         CREATE (member)-[:PARTICIPATES_IN {role:'member'}]->(conversation)`,
        { owner, member: groupMember, conversationId },
      );
    } finally {
      await session.close();
    }
  });

  afterAll(async () => {
    if (!driver) return;
    const session = driver.session();
    try {
      await session.run(
        `MATCH (node) WHERE (node:User AND node.id IN $userIds)
                         OR (node:Conversation AND node.id = $conversationId)
                         OR (node:AgentIntentDraft AND node.ownerUserId IN $userIds)
                         OR (node:OpenChatStory AND node.ownerUserId IN $userIds)
                         OR (node:AgentIntent AND node.ownerUserId IN $userIds)
                         OR (node:OpenChatSocialPreference AND node.userId IN $userIds)
         DETACH DELETE node`,
        { userIds, conversationId },
      );
    } finally {
      await session.close();
      await driver.close();
      await database.closeDatabase();
    }
  });

  it('keeps drafts owner-only and entirely outside intents and the human feed', async () => {
    const draft = await social.createIntentDraft(owner, {
      goal: 'Find a ticket', seeks: ['one ticket'], details: 'private allocation detail',
      source: 'private text thread', provenance: { messageId: 'private-message' }, confidence: 0.7,
    });
    expect((await social.listIntentDrafts(owner)).some((item) => item.id === draft.id)).toBe(true);
    expect(await social.listIntentDrafts(outsider)).toEqual([]);
    expect(await network.listIntents(owner)).toEqual([]);
    expect(await social.listStoryFeed(owner)).toEqual([]);
    expect(await social.listStoryFeed(selected)).toEqual([]);
    expect(await social.updateIntentDraft(owner, draft.id, { goal: '', seeks: [], brings: [] })).toBeNull();
    expect((await social.listIntentDrafts(owner)).find((item) => item.id === draft.id)?.goal).toBe('Find a ticket');
  });

  it('activates an agent-only object for 30 days without entering a human feed', async () => {
    const draft = await social.createIntentDraft(owner, {
      goal: 'Agent-only ticket search', seeks: ['festival ticket'], details: 'private maximum price',
    });
    const activated = await social.activateIntentDraft(owner, draft.id, {
      quietSearch: { enabled: true },
    }, { queueScan: false });
    expect(activated).not.toBeNull();
    expect(activated!.story.humanVisible).toBe(false);
    expect(activated!.story.storyExpiresAt).toBeNull();
    const defaultSearchDuration = Date.parse(activated!.story.searchExpiresAt) - Date.parse(activated!.story.createdAt);
    expect(defaultSearchDuration).toBeGreaterThanOrEqual(30 * 24 * 60 * 60 * 1000 - 1);
    expect(defaultSearchDuration).toBeLessThanOrEqual(30 * 24 * 60 * 60 * 1000);
    expect(await social.listStoryFeed(owner)).toEqual([]);
    expect(await social.listStoryFeed(selected)).toEqual([]);
    expect(JSON.stringify(activated!.story)).not.toMatch(/maximum price|source|provenance/);
    await social.withdrawStory(owner, activated!.story.id);
    expect((await network.listIntents(owner)).find((item) => item.id === activated!.intent.id)?.status).toBe('withdrawn');
  });

  it('enforces selected-user audience, blocks, expiry, and Story-only search duration', async () => {
    const created = await social.createStory(owner, {
      text: 'I have one extra ticket',
      audience: { userIds: [selected], conversationIds: [] },
    }, { queueScan: false });
    expect(created.story.searchExpiresAt).toBe(created.story.storyExpiresAt);
    expect((await social.listStoryFeed(selected)).map((story) => story.id)).toContain(created.story.id);
    expect((await social.listStoryFeed(outsider)).map((story) => story.id)).not.toContain(created.story.id);
    const serialized = JSON.stringify((await social.listStoryFeed(selected)).find((story) => story.id === created.story.id));
    expect(serialized).not.toMatch(/intentId|audience|ownerUserId|searchExpiresAt/);

    const session = driver.session();
    try {
      await session.run(
        `MATCH (viewer:User {id: $selected}), (owner:User {id: $owner}) MERGE (viewer)-[:BLOCKED]->(owner)`,
        { selected, owner },
      );
      expect((await social.listStoryFeed(selected)).map((story) => story.id)).not.toContain(created.story.id);
      await session.run(
        `MATCH (:User {id: $selected})-[block:BLOCKED]->(:User {id: $owner}) DELETE block`,
        { selected, owner },
      );
      await session.run(
        `MATCH (story:OpenChatStory {id: $storyId}) SET story.storyExpiresAt = datetime('2020-01-01T00:00:00Z')`,
        { storyId: created.story.id },
      );
      expect((await social.listStoryFeed(selected)).map((story) => story.id)).not.toContain(created.story.id);
    } finally {
      await session.close();
    }
  });

  it('enforces current conversation membership for conversation audiences', async () => {
    const created = await social.createStory(owner, {
      text: 'Group-only opportunity', goal: 'Build something together',
      audience: { userIds: [], conversationIds: [conversationId] },
    }, { queueScan: false });
    expect((await social.listStoryFeed(groupMember)).map((story) => story.id)).toContain(created.story.id);
    const session = driver.session();
    try {
      await session.run(
        `MATCH (:User {id: $member})-[membership:PARTICIPATES_IN]->(:Conversation {id: $conversationId}) DELETE membership`,
        { member: groupMember, conversationId },
      );
      expect((await social.listStoryFeed(groupMember)).map((story) => story.id)).not.toContain(created.story.id);
    } finally {
      await session.close();
    }
  });

  it('preserves separately approved quiet search when withdrawing its human Story', async () => {
    const created = await social.createStory(owner, {
      text: 'Visible briefly, searchable longer', goal: 'Find ticket', seeks: ['ticket'],
      audience: { userIds: [selected], conversationIds: [] }, quietSearch: { enabled: true },
    }, { queueScan: false });
    expect(Date.parse(created.story.searchExpiresAt)).toBeGreaterThan(Date.parse(created.story.storyExpiresAt!));
    const separatelyApprovedExpiry = created.story.searchExpiresAt;
    await social.updateStory(owner, created.story.id, {
      status: 'paused',
      storyExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const whilePaused = (await network.listIntents(owner)).find((item) => item.id === created.intent.id);
    expect(whilePaused?.status).toBe('active');
    expect(Date.parse(whilePaused?.expiresAt ?? '')).toBe(Date.parse(separatelyApprovedExpiry));
    await social.withdrawStory(owner, created.story.id);
    const intent = (await network.listIntents(owner)).find((item) => item.id === created.intent.id);
    expect(intent?.status).toBe('active');
    expect((await social.listStoryFeed(selected)).map((story) => story.id)).not.toContain(created.story.id);
  });

  it('pauses/resumes and synchronizes expiry only for Story-scoped discovery', async () => {
    const created = await social.createStory(owner, {
      text: 'Story-scoped search', goal: 'Borrow a truck', seeks: ['truck'],
      audience: { userIds: [selected], conversationIds: [] },
    }, { queueScan: false });
    await social.updateStory(owner, created.story.id, { status: 'paused' });
    expect((await network.listIntents(owner)).find((item) => item.id === created.intent.id)?.status).toBe('paused');
    const extended = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    await social.updateStory(owner, created.story.id, { status: 'active', storyExpiresAt: extended });
    const resumed = (await network.listIntents(owner)).find((item) => item.id === created.intent.id);
    expect(resumed?.status).toBe('active');
    expect(Date.parse(resumed?.expiresAt ?? '')).toBe(Date.parse(extended));
  });

  it('persists simple mode separately from network pause and redacts the bounded review queue', async () => {
    expect(await social.getSocialPreferences(quietPeer)).toEqual({
      experienceMode: 'enhanced', networkPaused: false, updatedAt: null,
    });
    const preference = await social.updateSocialPreferences(quietPeer, { experienceMode: 'simple', networkPaused: true });
    expect(preference).toMatchObject({ experienceMode: 'simple', networkPaused: true });
    const draft = await social.createIntentDraft(quietPeer, {
      goal: 'Private review item', seeks: ['help'], details: 'never in queue',
      source: 'never in queue', provenance: { secret: true },
    });
    const storyOnly = await social.createStory(quietPeer, {
      text: 'One expiring review item', audience: { userIds: [owner], conversationIds: [] },
    }, { queueScan: false });
    const queue = await social.getReviewQueue(quietPeer);
    expect(queue.items.length).toBeLessThanOrEqual(50);
    expect(queue.items.find((item) => item.id === `draft:${draft.id}`)).toBeTruthy();
    expect(queue.items.filter((item) => item.storyId === storyOnly.story.id)).toEqual([
      expect.objectContaining({ kind: 'expiring_story' }),
    ]);
    expect(JSON.stringify(queue)).not.toMatch(/never in queue|provenance|details|source/);
  });
});
