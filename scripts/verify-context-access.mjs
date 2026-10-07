// Run inside a built server: node /path/to/verify-context-access.mjs /app/apps/server/dist
// All fixtures and mutations stay inside one transaction, rolled back even on failure.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const dist = process.argv[2];
if (!dist) throw new Error('Pass the absolute server dist directory');
const { getDriver } = await import(pathToFileURL(`${dist}/db.js`));
const { checkContextReadAccess, checkContextWriteAccess } = await import(pathToFileURL(`${dist}/services/contextAccess.js`));
const { createContextPost, updateContextPost, deleteContextPost } = await import(pathToFileURL(`${dist}/services/contextLane.js`));
const driver = getDriver(), session = driver.session(), tx = session.beginTransaction();
const suffix = crypto.randomUUID(), userId = `context-check-${suffix}`, conversationId = `context-room-${suffix}`, agentKeyId = `context-key-${suffix}`;
try {
  await tx.run(`CREATE (u:User {id:$userId}), (c:Conversation {id:$conversationId}), (k:AgentKey {id:$agentKeyId, ownerUserId:$userId, scopes:['read','write']}) CREATE (u)-[:PARTICIPATES_IN]->(c)`, { userId, conversationId, agentKeyId });
  const args = [tx, userId, conversationId, agentKeyId, ['read','write']];
  assert.equal(await checkContextReadAccess(...args), true);
  assert.equal(await checkContextWriteAccess(...args), true);
  assert.equal(await checkContextReadAccess(tx, 'other-owner', conversationId, agentKeyId, ['read','write']), false);
  const input = { text: 'Context regression fixture', clientRequestId: suffix, kind: 'note' };
  const adapter = { executeWrite: fn => fn(tx) };
  const first = await createContextPost(adapter, userId, conversationId, input, agentKeyId, ['read','write']);
  const retry = await createContextPost(adapter, userId, conversationId, input, agentKeyId, ['read','write']);
  assert.equal(first.id, retry.id);
  const edited = await updateContextPost(adapter, userId, conversationId, first.id, 'Edited fixture', 1, agentKeyId, ['read','write']);
  assert.equal(edited.text, 'Edited fixture');
  assert.equal(edited.revision.toNumber?.() ?? edited.revision, 2);
  await assert.rejects(() => updateContextPost(adapter, userId, conversationId, first.id, 'Stale edit', 1, agentKeyId, ['read','write']), /Revision mismatch/);
  await deleteContextPost(adapter, userId, conversationId, first.id, agentKeyId, ['read','write']);
  const tombstone = (await tx.run('MATCH (t:Thought {id:$id}) RETURN t', {id:first.id})).records[0].get('t').properties;
  assert.equal(tombstone.text, '');
  assert.ok(tombstone.deletedAt);
  for (const patch of ["k.revokedAt='revoked'", "k.revokedAt=null, k.expiresAt='2000-01-01T00:00:00Z'", "k.expiresAt=null, k.ownerUserId='other-owner'", "k.ownerUserId=$userId, k.scopes=[]"]) {
    await tx.run(`MATCH (k:AgentKey {id:$agentKeyId}) SET ${patch}`, { agentKeyId, userId });
    assert.equal(await checkContextReadAccess(...args), false);
    assert.equal(await checkContextWriteAccess(...args), false);
  }
  await tx.run("MATCH (k:AgentKey {id:$agentKeyId}) SET k.scopes=['read']", { agentKeyId });
  assert.equal(await checkContextReadAccess(...args), true);
  assert.equal(await checkContextWriteAccess(...args), false);
  await tx.run('MATCH (:User {id:$userId})-[p:PARTICIPATES_IN]->() DELETE p', {userId});
  assert.equal(await checkContextReadAccess(...args), false);
  console.log('PASS: same-key context create/retry/read/edit/delete, revision conflicts, membership, ownership, scope, expiry and revocation; all fixtures rolled back.');
} finally { await tx.rollback(); await session.close(); await driver.close(); }
