import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import neo4j, { type Driver } from 'neo4j-driver';

// Regression cover for the 2026-09-08 failure: Jacob asked the Assistant to
// text Robert, the Assistant found him, asked to confirm, Jacob said "yes", and
// the send died with "You do not have access to that conversation." Two causes:
// the model had to carry an opaque conversationId across a turn boundary (tool
// results are never persisted), and there was no person-shaped send tool at all.
const uri = process.env.NEO4J_TEST_URI;
const user = process.env.NEO4J_TEST_USER;
const password = process.env.NEO4J_TEST_PASSWORD;
const integration = uri && user && password ? describe.sequential : describe.skip;

integration('assistant send_message_to_person', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const senderId = `sender-${suffix}`;
  const knownId = `known-${suffix}`;
  const strangerId = `stranger-${suffix}`;
  const twinAId = `twin-a-${suffix}`;
  const twinBId = `twin-b-${suffix}`;
  const ownerId = `owner-${suffix}`;
  const claireKnownId = `claire-known-${suffix}`;
  const claireOtherId = `claire-other-${suffix}`;
  const userIds = [senderId, knownId, strangerId, twinAId, twinBId, ownerId, claireKnownId, claireOtherId];

  let driver: Driver;
  let database: typeof import('../src/db.js');
  let assistant: typeof import('../src/services/assistant.js');
  let directService: typeof import('../src/services/directConversation.js');

  beforeAll(async () => {
    process.env.NEO4J_URI = uri!;
    process.env.NEO4J_USER = user!;
    process.env.NEO4J_PASSWORD = password!;
    database = await import('../src/db.js');
    assistant = await import('../src/services/assistant.js');
    directService = await import('../src/services/directConversation.js');
    await database.initDatabase();

    driver = neo4j.driver(uri!, neo4j.auth.basic(user!, password!));
    const session = driver.session();
    try {
      await session.run(
        `UNWIND $people AS person
         CREATE (:User {id: person.id, name: person.name, email: person.email})`,
        {
          people: [
            { id: senderId, name: 'Sender Person', email: `${senderId}@example.test` },
            { id: knownId, name: 'Robert Nowell', email: `${knownId}@example.test` },
            { id: strangerId, name: 'Robert Stranger', email: `${strangerId}@example.test` },
            { id: twinAId, name: 'Sam Twin', email: `${twinAId}@example.test` },
            { id: twinBId, name: 'Sam Twin', email: `${twinBId}@example.test` },
            { id: claireKnownId, name: 'Claire Dubois', email: `${claireKnownId}@example.test` },
            { id: claireOtherId, name: 'Claire Unmet', email: `${claireOtherId}@example.test` },
          ],
        },
      );
    } finally {
      await session.close();
    }

    // The sender already shares a DM with Robert Nowell and both Sam Twins.
    // Robert Stranger is a non-contact, so name lookup must not reach him.
    await directService.ensureDirectConversation(senderId, knownId);
    await directService.ensureDirectConversation(senderId, twinAId);
    await directService.ensureDirectConversation(senderId, twinBId);

    // OpenChat-lfua: a directory-browsing account (like the owner's) that has
    // only ever messaged one Claire.
    const ownerSession = driver.session();
    try {
      await ownerSession.run(
        `CREATE (:User {id: $ownerId, name: 'Directory Owner', email: $email, canBrowseUserDirectory: true})`,
        { ownerId, email: `${ownerId}@example.test` },
      );
    } finally {
      await ownerSession.close();
    }
    await directService.ensureDirectConversation(ownerId, claireKnownId);
  });

  afterAll(async () => {
    if (!driver) return;
    const session = driver.session();
    try {
      await session.run(
        `
        MATCH (u:User)-[:PARTICIPATES_IN]->(conversation:Conversation)
        WHERE u.id IN $userIds
        WITH collect(DISTINCT conversation) AS conversations
        UNWIND conversations AS conversation
        OPTIONAL MATCH (message:Message {conversationId: conversation.id})
        DETACH DELETE message, conversation
        `,
        { userIds },
      );
      await session.run(`MATCH (u:User) WHERE u.id IN $userIds DETACH DELETE u`, { userIds });
    } finally {
      await session.close();
      await driver.close();
      await database.closeDatabase();
    }
  });

  it('resolves a person the user already shares a conversation with, by name', async () => {
    const people = await assistant.resolvePeople(senderId, 'robert');
    expect(people.map(p => p.id)).toEqual([knownId]);
    expect(people[0]?.known).toBe(true);
  });

  it('does not expose a non-contact by name, but does by complete email', async () => {
    const byName = await assistant.resolvePeople(senderId, 'Robert Stranger');
    expect(byName).toEqual([]);

    const byEmail = await assistant.resolvePeople(senderId, `${strangerId}@example.test`);
    expect(byEmail.map(p => p.id)).toEqual([strangerId]);
  });

  it('with directory access, a first name means the person you already message', async () => {
    const people = await assistant.resolvePeople(ownerId, 'Claire');
    expect(people.map(p => p.id)).toEqual([claireKnownId]);
  });

  it('with directory access, falls back to the directory when nobody known matches', async () => {
    const people = await assistant.resolvePeople(ownerId, 'Claire Unmet');
    expect(people.map(p => p.id)).toEqual([claireOtherId]);
  });

  it('post_context asks for confirmation first, then posts quietly with agent attribution (OpenChat-oppa)', async () => {
    const preview = await assistant.toolPostContext(undefined, ownerId, { person: 'Claire', text: 'hi test' }) as Record<string, unknown>;
    expect(preview).toMatchObject({ needsConfirmation: true, destination: 'Claire Dubois', kind: 'note', preview: 'hi test' });

    const posted = await assistant.toolPostContext(undefined, ownerId, { person: 'Claire', text: 'hi test', confirm: true }) as Record<string, unknown>;
    expect(posted).toMatchObject({ ok: true, posted: { destination: 'Claire Dubois', kind: 'note', text: 'hi test' } });

    const read = await assistant.toolReadContext(undefined, ownerId, { person: 'Claire' }) as { posts: Array<Record<string, unknown>> };
    expect(read.posts.map(p => [p.text, p.viaAgent])).toEqual([['hi test', 'OpenChat Agent (owner approved)']]);

    // Quiet: nothing was added to the chat lane.
    const session = driver.session();
    try {
      const messages = await session.run(
        `MATCH (:User {id: $ownerId})-[:PARTICIPATES_IN]->(c:Conversation {type: 'direct'})<-[:PARTICIPATES_IN]-(:User {id: $claireKnownId})
         OPTIONAL MATCH (m:Message {conversationId: c.id}) RETURN count(m) AS n`,
        { ownerId, claireKnownId },
      );
      expect(Number(messages.records[0]?.get('n'))).toBe(0);
    } finally {
      await session.close();
    }
  });

  it('strips markdown the chat bubble cannot render', () => {
    expect(assistant.plainChatText('Found **Claire** in `TF8B`\n## Done')).toBe('Found Claire in TF8B\nDone');
  });

  it('never resolves the user themselves', async () => {
    const people = await assistant.resolvePeople(senderId, 'Sender');
    expect(people).toEqual([]);
  });

  it('confirms before sending, remembers the pending send, then delivers on confirm', async () => {
    const content = 'test';

    const first = await assistant.toolSendMessageToPerson(
      undefined, senderId, 'Robert', content, false,
    ) as { needsConfirmation?: boolean; recipient?: string };
    expect(first.needsConfirmation).toBe(true);
    expect(first.recipient).toBe('Robert Nowell');

    // The whole point: after the confirm-gated turn ends, the conversationId is
    // still recoverable server-side, so the next turn's "yes" can complete.
    const pending = assistant.getPendingSend(senderId);
    expect(pending?.content).toBe(content);
    expect(pending?.conversationId).toBeTruthy();

    const sent = await assistant.toolSendMessageToPerson(
      undefined, senderId, 'Robert', content, true,
    ) as { ok?: boolean; sentTo?: string; conversationId?: string };
    expect(sent.ok).toBe(true);
    expect(sent.sentTo).toBe('Robert Nowell');
    expect(sent.conversationId).toBe(pending?.conversationId);

    // Sending clears the pending slot so a later unrelated "yes" can't resend.
    expect(assistant.getPendingSend(senderId)).toBeNull();

    // It landed in the DM the two of them already shared — no duplicate thread.
    const { conversation, created } = await directService.ensureDirectConversation(senderId, knownId);
    expect(created).toBe(false);
    expect(conversation.id).toBe(sent.conversationId);

    const session = driver.session();
    try {
      const result = await session.run(
        `MATCH (m:Message {conversationId: $conversationId})
         RETURN m.content AS content, m.senderId AS senderId, m.viaAssistant AS viaAssistant`,
        { conversationId: sent.conversationId },
      );
      expect(result.records).toHaveLength(1);
      expect(result.records[0]!.get('content')).toBe(content);
      expect(result.records[0]!.get('senderId')).toBe(senderId);
      expect(result.records[0]!.get('viaAssistant')).toBe(true);
    } finally {
      await session.close();
    }
  });

  it('refuses to guess between two people with the same name', async () => {
    const result = await assistant.toolSendMessageToPerson(
      undefined, senderId, 'Sam Twin', 'hello', false,
    ) as { ambiguous?: boolean; candidates?: unknown[] };
    expect(result.ambiguous).toBe(true);
    expect(result.candidates).toHaveLength(2);
  });

  it('reports an unreachable person instead of sending somewhere wrong', async () => {
    const result = await assistant.toolSendMessageToPerson(
      undefined, senderId, 'Nobody At All', 'hello', true,
    ) as { error?: string; ok?: boolean };
    expect(result.ok).toBeUndefined();
    expect(result.error).toContain('Nobody At All');
  });
});
