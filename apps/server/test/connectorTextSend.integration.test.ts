import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import neo4j, { type Driver } from 'neo4j-driver';
let driver: Driver;
vi.mock('../src/db.js', () => ({ getDriver: () => driver }));
import { sendConnectorText } from '../src/services/connectorTextSend.js';
import { PEOPLE_SUGGESTIONS_QUERY } from '../src/services/peopleSuggestions.js';
import { acquireContextAclLocks } from '../src/services/contextAccess.js';
const uri = process.env.NEO4J_TEST_URI;
const run = uri ? it : it.skip;
const prefix = `connector-text-${Math.random().toString(36).slice(2)}-`;
const id = (key: string): string => prefix + key;
const person = (key: string) => ({ kind: 'person' as const, id: id(key) });
const send = (key: string, requestId: string, content = ' exact synthetic snapshot ', actor = 'actor') =>
  sendConnectorText({ actorId: id(actor), target: person(key), requestId, content, connectorLabel: 'Fixture Vision' });
async function query(cypher: string, parameters: Record<string, unknown> = {}) {
  const session = driver.session();
  try { return await session.run(cypher, parameters); } finally { await session.close(); }
}
beforeAll(async () => {
  if (!uri) return;
  expect(['127.0.0.1', 'localhost', '[::1]']).toContain(new URL(uri).hostname);
  driver = neo4j.driver(uri, process.env.NEO4J_TEST_PASSWORD
    ? neo4j.auth.basic(process.env.NEO4J_TEST_USER || 'neo4j', process.env.NEO4J_TEST_PASSWORD) : undefined);
  await driver.verifyConnectivity();
  for (const statement of [
    'CREATE CONSTRAINT connector_text_receipt_id IF NOT EXISTS FOR (r:ConnectorTextReceipt) REQUIRE r.id IS UNIQUE',
    'CREATE CONSTRAINT message_id IF NOT EXISTS FOR (m:Message) REQUIRE m.id IS UNIQUE',
    'CREATE CONSTRAINT conversation_direct_pair IF NOT EXISTS FOR (c:Conversation) REQUIRE c.directPairKey IS UNIQUE',
  ]) await query(statement);
  const keys = ['actor', 'other', 'concurrent', 'replay', 'conflict', 'second', 'known-hidden', 'friend-hidden', 'hidden', 'email', 'blocked', 'blocker', 'race', 'bot', 'group-peer'];
  await query('UNWIND $people AS p CREATE (u:User) SET u=p', { people: keys.map(key => ({
    id: id(key), name: 'Fixture ' + key, discoveryMode: key.includes('hidden') ? 'hidden' : key === 'email' ? 'email_only' : 'name',
    isBot: key === 'bot', ideaflowIssuer: 'https://id.ideaflow.app/api/auth', ideaflowSub: id('subject-' + key),
  })) });
  await query(`MATCH (a:User {id:$actor}), (p:User {id:$person})
    CREATE (c:Conversation {id:$conversation,type:'group'})
    CREATE (a)-[:PARTICIPATES_IN]->(c), (p)-[:PARTICIPATES_IN]->(c)`, {
    actor: id('actor'), person: id('known-hidden'), conversation: id('known-group'),
  });
  await query("CREATE (:OpenChatConnection {pairKey:$key,state:'accepted'})", { key: JSON.stringify([id('actor'), id('friend-hidden')].sort()) });
  await query(`MATCH (a:User {id:$actor}), (b:User {id:$blocked}), (c:User {id:$blocker})
    CREATE (a)-[:BLOCKED]->(b), (c)-[:BLOCKED]->(a)`, { actor: id('actor'), blocked: id('blocked'), blocker: id('blocker') });
}, 60000);
afterAll(async () => {
  if (!driver) return;
  try {
    await query('MATCH (r:ConnectorTextReceipt) WHERE r.ownerUserId STARTS WITH $prefix DETACH DELETE r', { prefix });
    await query('MATCH (c:OpenChatConnection) WHERE c.pairKey CONTAINS $prefix DELETE c', { prefix });
    await query('MATCH (n) WHERE n.id STARTS WITH $prefix OR (n:Message AND n.senderId STARTS WITH $prefix) DETACH DELETE n', { prefix });
  } finally { await driver.close(); }
}, 60000);
run('concurrent retries produce one canonical DM, one message and one immutable receipt', async () => {
  const results = await Promise.all(Array.from({ length: 12 }, () => send('concurrent', 'concurrent-nonce')));
  expect(new Set(results.map(r => r.receipt.messageId)).size).toBe(1);
  expect(results.filter(r => !r.receipt.replayed)).toHaveLength(1);
  expect(results.filter(r => r.message)).toHaveLength(1);
  const state = await query(`MATCH (a:User {id:$actor})-[:PARTICIPATES_IN]->(c:Conversation {type:'direct'})<-[:PARTICIPATES_IN]-(p:User {id:$person})
    MATCH (m:Message {conversationId:c.id})
    RETURN count(DISTINCT c) AS conversations,count(DISTINCT m) AS messages,collect(m.connectorAgentId) AS provenance,collect(m.agentName) AS names`, {
    actor: id('actor'), person: id('concurrent'),
  });
  expect(Number(state.records[0].get('conversations'))).toBe(1);
  expect(Number(state.records[0].get('messages'))).toBe(1);
  expect(state.records[0].get('provenance')).toEqual(['ideaflow-connector']);
  expect(state.records[0].get('names')).toEqual(['Fixture Vision']);
});
run('receipt survives edits, message/conversation removal and later blocks without recreation', async () => {
  const first = await send('replay', 'replay-nonce');
  await query("MATCH (m:Message {id:$id}) SET m.content='Message deleted',m.deletedAt=datetime()", { id: first.receipt.messageId });
  const edited = await sendConnectorText({ actorId: id('actor'), target: person('replay'), requestId: 'replay-nonce',
    content: ' exact synthetic snapshot ', connectorLabel: 'Renamed fixture' });
  expect(edited.receipt.messageId).toBe(first.receipt.messageId);
  expect(edited.message).toBeUndefined();
  expect((await query('MATCH (m:Message {id:$id}) RETURN m.content AS content', { id: first.receipt.messageId })).records[0].get('content')).toBe('Message deleted');
  await query('MATCH (m:Message {id:$id}) DETACH DELETE m', { id: first.receipt.messageId });
  await query('MATCH (c:Conversation {id:$id}) DETACH DELETE c', { id: first.receipt.conversationId });
  await query("MATCH (a:User {id:$actor}),(p:User {id:$person}) SET p.discoveryMode='hidden' CREATE (a)-[:BLOCKED]->(p)", { actor: id('actor'), person: id('replay') });
  const replay = await send('replay', 'replay-nonce');
  expect(replay.receipt).toEqual({ ...first.receipt, replayed: true });
  expect(replay.message).toBeUndefined();
  const absent = await query('MATCH (c:Conversation {directPairKey:$pair}) RETURN c.id AS id', { pair: JSON.stringify([id('actor'), id('replay')].sort()) });
  expect(absent.records).toHaveLength(0);
  await expect(send('replay', 'new-after-block')).rejects.toMatchObject({ code: 'unavailable' });
});
run('actor-bound nonce rejects changed recipient/content and isolates another actor', async () => {
  const first = await send('conflict', 'same-nonce');
  await expect(send('conflict', 'same-nonce', 'changed')).rejects.toMatchObject({ code: 'request_conflict' });
  await expect(send('second', 'same-nonce')).rejects.toMatchObject({ code: 'request_conflict' });
  const other = await send('conflict', 'same-nonce', ' exact synthetic snapshot ', 'other');
  expect(other.receipt.messageId).not.toBe(first.receipt.messageId);
  expect(other.receipt.conversationId).not.toBe(first.receipt.conversationId);
});
run('current eligibility rejects private unknowns/bots/self/mutual blocks before DM creation', async () => {
  for (const key of ['known-hidden', 'friend-hidden']) expect((await send(key, 'eligible-' + key)).receipt.accepted).toBe(true);
  for (const key of ['hidden', 'email', 'blocked', 'blocker', 'bot', 'actor']) {
    await expect(send(key, 'denied-' + key)).rejects.toMatchObject({ code: 'unavailable' });
    const created = await query('MATCH (c:Conversation {directPairKey:$pair}) RETURN c.id AS id', { pair: JSON.stringify([...new Set([id('actor'), id(key)])].sort()) });
    expect(created.records).toHaveLength(0);
  }
});
run('a committed block holding the same pair locks wins before fresh admission', async () => {
  const blocker = driver.session();
  const tx = blocker.beginTransaction();
  try {
    await acquireContextAclLocks(tx, { userIds: [id('actor'), id('race')] });
    await tx.run('MATCH (a:User {id:$actor}),(p:User {id:$person}) CREATE (p)-[:BLOCKED]->(a)', { actor: id('actor'), person: id('race') });
    const pending = send('race', 'blocked-race-nonce');
    await tx.commit();
    await expect(pending).rejects.toMatchObject({ code: 'unavailable' });
  } finally { if (tx.isOpen()) await tx.rollback(); await blocker.close(); }
});
run('existing-conversation mode preserves group replies and refuses missing/nonmember destinations', async () => {
  const conversationId = id('existing-group'), replyId = id('reply');
  await query(`MATCH (a:User {id:$actor}),(p:User {id:$person})
    CREATE (c:Conversation {id:$conversationId,type:'group'}), (a)-[:PARTICIPATES_IN]->(c), (p)-[:PARTICIPATES_IN]->(c)
    CREATE (:Message {id:$replyId,conversationId:$conversationId,senderId:$person,content:'Synthetic reply target',messageType:'text',createdAt:datetime()})`, {
    actor: id('actor'), person: id('group-peer'), conversationId, replyId,
  });
  const result = await sendConnectorText({ actorId: id('actor'), target: { kind: 'conversation', id: conversationId },
    requestId: 'group-reply', content: 'Group reply snapshot', replyToId: replyId });
  expect(result.receipt.accepted).toBe(true);
  expect(result.message?.replyTo).toMatchObject({ id: replyId });
  for (const [actor, target] of [['other', conversationId], ['actor', id('missing')]]) {
    await expect(sendConnectorText({ actorId: id(actor), target: { kind: 'conversation', id: target },
      requestId: 'unavailable', content: 'Must not send/create' })).rejects.toMatchObject({ code: 'unavailable' });
  }
});
run('connector delivery never establishes actual-human-DM evidence', async () => {
  const result = await query(PEOPLE_SUGGESTIONS_QUERY, { userId: id('actor'), issuer: 'https://id.ideaflow.app/api/auth',
    subjects: [], empty: true, name: '', email: '', limit: neo4j.int(100) });
  const sent = result.records.find(record => record.get('userId') === id('concurrent'));
  expect(sent).toBeDefined();
  expect(sent!.get('chatted')).toBe(false);
  expect(sent!.get('lastChattedAt')).toBeNull();
});
