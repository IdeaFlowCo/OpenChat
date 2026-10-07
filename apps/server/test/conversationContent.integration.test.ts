import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import neo4j, { type Driver } from 'neo4j-driver';
import { listConversationContent } from '../src/services/conversationContent.js';
import { pinThoughtWithReview } from '../src/services/pinThoughtWithReview.js';
import { createContextPost } from '../src/services/contextLane.js';
const integration = process.env.NEO4J_TEST_URI ? describe.sequential : describe.skip;
integration('unified conversation content audience and pagination with real Neo4j', () => {
  let driver: Driver; const prefix = `content-${crypto.randomUUID()}`, a = `${prefix}-a`, b = `${prefix}-b`, room = `${prefix}-room`, other = `${prefix}-other`, key = `${prefix}-key`;
  const session = async <T>(fn: (s: any) => Promise<T>) => { const s = driver.session(); try { return await fn(s); } finally { await s.close(); } };
  const run = (query: string, params: Record<string, unknown> = {}) => session(s => s.run(query, params)) as Promise<any>;
  const read = (opts: any = {}, user = a, agent?: string, scopes?: string[]) => session(s => listConversationContent(s, user, room, opts, agent, scopes));
  beforeAll(async () => {
    driver = neo4j.driver(process.env.NEO4J_TEST_URI!, neo4j.auth.basic(process.env.NEO4J_TEST_USER || 'neo4j', process.env.NEO4J_TEST_PASSWORD || 'test'));
    await run(`CREATE (a:User {id:$a,name:'Alice'}),(b:User {id:$b,name:'Bob'}),(c:Conversation {id:$room,lastMessagePreview:'unchanged'}),(other:Conversation {id:$other}),
      (k:AgentKey {id:$key,ownerUserId:$a,scopes:['read']}),
      (message:Message {id:$prefix+'-message',conversationId:$room,text:'Shared source'}),
      (foreign:Message {id:$prefix+'-foreign',conversationId:$other,text:'Protected source'}),
      (mine:Thought {id:$prefix+'-mine',userId:$a,text:'PRIVATE owner note',scopeConversationId:$room,kind:'observation',status:'open',createdAt:datetime('2026-10-07T00:00:00Z')}),
      (theirs:Thought {id:$prefix+'-theirs',userId:$b,text:'PRIVATE other note',scopeConversationId:$room,kind:'observation',createdAt:datetime('2026-10-07T00:00:00Z')}),
      (tag1:Thought {id:$prefix+'-tag1',userId:$b,text:'Shared #alpha #beta',captureMethod:'inline-tag',tags:['alpha'],kind:'observation',createdAt:datetime('2026-10-07T00:00:00Z')}),
      (tag2:Thought {id:$prefix+'-tag2',userId:$b,text:'Shared #alpha #beta',captureMethod:'inline-tag',tags:['beta'],kind:'observation',createdAt:datetime('2026-10-07T00:00:00Z')}),
      (pin:Thought {id:$prefix+'-pin',userId:$b,text:'Explicitly pinned text',kind:'fact',createdAt:datetime('2026-10-07T00:00:00Z')})
      CREATE (a)-[:PARTICIPATES_IN {lastReadAt:'before'}]->(c),(b)-[:PARTICIPATES_IN]->(c),(b)-[:PARTICIPATES_IN]->(other),
        (a)-[:HAS_THOUGHT]->(mine),(b)-[:HAS_THOUGHT]->(theirs),(tag1)-[:FROM_MESSAGE]->(message),(tag2)-[:FROM_MESSAGE]->(message),
        (pin)-[:FROM_MESSAGE]->(foreign),(pin)-[:PINNED_IN {pinnedBy:$b,pinnedAt:datetime('2026-10-07T00:00:00Z')}]->(c)`, { prefix, a, b, room, other, key });
    await run(`MATCH (a:User {id:$a}) CREATE (a)-[:HAS_THOUGHT]->(:Thought {id:$prefix+'-deleted',userId:$a,scopeConversationId:$room,text:'DELETED PRIVATE TEXT',deletedAt:datetime(),createdAt:datetime('2026-10-07T00:00:00Z')})`, { a, prefix, room });
    const parent = await session(s => createContextPost(s, a, room, { text: 'Context question', kind: 'ask', clientRequestId: `${prefix}-context` }));
    await session(s => createContextPost(s, b, room, { text: 'Threaded reply', replyToId: parent.id, clientRequestId: `${prefix}-reply` }));
    await run(`MATCH (t:Thought {conversationId:$room}) SET t.createdAt=datetime('2026-10-07T00:00:00Z')`, { room });
  });
  afterAll(async () => { await run(`MATCH (n) WHERE n.id STARTS WITH $prefix OR n.conversationId=$room DETACH DELETE n`, { prefix, room }); await driver.close(); });
  it('unifies Context and eligible Stream entries while keeping owner-private audience explicit', async () => {
    const page = await read({ includePrivate: true }); expect(page.items).toHaveLength(5);
    expect(page.items.find(item => item.id === `${prefix}-mine`)).toMatchObject({ visibility: 'private', provenance: 'private_note' });
    expect(JSON.stringify(page)).not.toContain('PRIVATE other note'); expect(JSON.stringify(page)).not.toContain('DELETED PRIVATE TEXT');
    expect(page.items.find(item => item.origin === 'context' && item.context.replyToId)?.context?.replyTo?.text).toBe('Context question');
  });
  it('coalesces legacy capture aliases before pagination and unions tags deterministically', async () => {
    const row = (await read()).items.find(item => item.id === `${prefix}-tag1`)!;
    expect(row.sourceAliases).toEqual([`${prefix}-tag1`, `${prefix}-tag2`]);
    expect(row).toMatchObject({ origin: 'stream', thought: { tags: ['alpha', 'beta'] } });
    const ids: string[] = []; let cursor: string | undefined;
    do { const page = await read({ limit: 1, cursor, includePrivate: true }); ids.push(...page.items.map(item => item.id)); cursor = page.nextCursor; } while (cursor);
    expect(ids).toHaveLength(5); expect(new Set(ids).size).toBe(5);
    expect(ids).toEqual([...ids].sort().reverse());
  });
  it('redacts cross-conversation source identifiers but retains explicitly shared pinned text', async () => {
    const row = (await read()).items.find(item => item.id === `${prefix}-pin`)!;
    expect(row).toMatchObject({ visibility: 'conversation', provenance: 'pinned', thought: { text: 'Explicitly pinned text', hasSourceMessage: true, sourceMessageId: null, sourceConversationId: null } });
    expect(JSON.stringify(row)).not.toContain(`${prefix}-foreign`);
  });
  it('never exposes private entries to API keys even when includePrivate is passed', async () => {
    const page = await read({ includePrivate: true }, a, key, ['read']); expect(page.items).toHaveLength(4); expect(JSON.stringify(page)).not.toContain('PRIVATE');
    await run('MATCH (k:AgentKey {id:$key}) SET k.revokedAt="revoked"', { key });
    await expect(read({}, a, key, ['read'])).rejects.toMatchObject({ statusCode: 403 });
    await run('MATCH (k:AgentKey {id:$key}) REMOVE k.revokedAt', { key });
  });
  it('binds cursors to viewer, search, filter and private mode', async () => {
    const cursor = (await read({ limit: 1, includePrivate: true })).nextCursor;
    for (const options of [{ cursor }, { cursor, includePrivate: true, search: 'Shared' }, { cursor, includePrivate: true, filter: 'stream' }]) await expect(read(options)).rejects.toMatchObject({ statusCode: 400 });
    await expect(read({ cursor, includePrivate: true }, b)).rejects.toMatchObject({ statusCode: 400 });
    expect((await read({ filter: 'stream', search: 'BETA' })).items).toHaveLength(1);
    expect((await read({ filter: 'context' })).items).toHaveLength(2);
  });
  it('rejects changed private pin text before sharing and rechecks the destination membership', async () => {
    await expect(session(s => pinThoughtWithReview(s, a, `${prefix}-mine`, room, new Date().toISOString()))).rejects.toMatchObject({ statusCode: 400 });
    await expect(session(s => pinThoughtWithReview(s, a, `${prefix}-mine`, room, new Date().toISOString(), 'Old reviewed text'))).rejects.toMatchObject({ statusCode: 409 });
    let state = await run('MATCH (t:Thought {id:$id}) RETURN EXISTS { MATCH (t)-[:PINNED_IN]->(:Conversation {id:$room}) } AS shared', { id: `${prefix}-mine`, room });
    expect(state.records[0].get('shared')).toBe(false);
    await expect(session(s => pinThoughtWithReview(s, a, `${prefix}-mine`, other, new Date().toISOString(), 'PRIVATE owner note'))).rejects.toMatchObject({ statusCode: 404 });
    await session(s => pinThoughtWithReview(s, a, `${prefix}-mine`, room, new Date().toISOString(), 'PRIVATE owner note'));
    state = await read(); expect(state.items.find((item: any) => item.id === `${prefix}-mine`)).toMatchObject({ visibility: 'conversation', provenance: 'pinned' });
  });
  it('rechecks membership on later pages without changing ordinary chat state', async () => {
    const cursor = (await read({ limit: 1 })).nextCursor;
    await run('MATCH (:User {id:$a})-[r:PARTICIPATES_IN]->(:Conversation {id:$room}) DELETE r', { a, room });
    await expect(read({ cursor })).rejects.toMatchObject({ statusCode: 403 });
    const result = await run('MATCH (c:Conversation {id:$room}) RETURN c.lastMessagePreview AS preview', { room });
    expect(result.records[0].get('preview')).toBe('unchanged');
  });
});
