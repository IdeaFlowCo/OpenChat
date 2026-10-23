import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import neo4j, { type Driver } from 'neo4j-driver';
import { readFileSync } from 'node:fs';
import { deleteImportedChatsForUser, exportImportedChatsForUser } from '../src/services/importedChatAccount.js';

const integration = process.env.NEO4J_TEST_URI ? describe.sequential : describe.skip;
integration('imported archive account lifecycle', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const alice = `archive-lifecycle-alice-${suffix}`;
  const bob = `archive-lifecycle-bob-${suffix}`;
  const labels = ['OpenChatImportedChat', 'OpenChatImportedParticipant', 'OpenChatImportedMessage', 'OpenChatImportedFact', 'OpenChatImportedAsk'];
  let driver: Driver;

  beforeAll(async () => {
    process.env.NEO4J_URI = process.env.NEO4J_TEST_URI!;
    process.env.NEO4J_USER = process.env.NEO4J_TEST_USER || 'neo4j';
    process.env.NEO4J_PASSWORD = process.env.NEO4J_TEST_PASSWORD || 'test';
    driver = neo4j.driver(process.env.NEO4J_TEST_URI!, neo4j.auth.basic(process.env.NEO4J_TEST_USER || 'neo4j', process.env.NEO4J_TEST_PASSWORD || 'test'));
    const session = driver.session();
    try {
      await session.run('UNWIND $owners AS id CREATE (:User {id: id})', { owners: [alice, bob] });
      for (const label of labels) await session.run(`UNWIND $owners AS owner CREATE (:${label} {id: owner + $label, ownerUserId: owner, text: 'private fixture'})`, { owners: [alice, bob], label });
      await session.run('MATCH (p:OpenChatImportedParticipant {ownerUserId: $bob}) SET p.linkedUserId = $alice, p.linkedAt = "2026-01-01"', { alice, bob });
    } finally { await session.close(); }
  });

  afterAll(async () => {
    if (!driver) return;
    const session = driver.session();
    try {
      for (const owner of [alice, bob]) await session.executeWrite(tx => deleteImportedChatsForUser(tx, owner));
      await session.run('MATCH (u:User) WHERE u.id IN $owners DETACH DELETE u', { owners: [alice, bob] });
    } finally { await session.close(); await driver.close(); await (await import('../src/db.js')).closeDatabase(); }
  });

  it('exports only the owner and deletes all owned archive data while retaining another owner’s copy', async () => {
    const session = driver.session();
    try {
      const before = await session.executeRead(tx => exportImportedChatsForUser(tx, alice));
      expect(before.scope).toBe('all_time');
      for (const collection of ['chats', 'participants', 'messages', 'facts', 'asks']) {
        expect(before[collection]).toEqual([expect.objectContaining({ ownerUserId: alice })]);
      }
      await session.executeWrite(tx => deleteImportedChatsForUser(tx, alice));
      const after = await session.executeRead(tx => exportImportedChatsForUser(tx, alice));
      for (const collection of ['chats', 'participants', 'messages', 'facts', 'asks']) expect(after[collection]).toEqual([]);
      const other = await session.executeRead(tx => exportImportedChatsForUser(tx, bob));
      for (const collection of ['chats', 'participants', 'messages', 'facts', 'asks']) {
        expect(other[collection]).toEqual([expect.objectContaining({ ownerUserId: bob, text: 'private fixture' })]);
      }
      expect(other.participants[0]).not.toHaveProperty('linkedUserId');
      expect(other.participants[0]).not.toHaveProperty('linkedAt');
    } finally { await session.close(); }
  });

  it('cannot recreate an archive while account deletion is in flight', async () => {
    const service = await import('../src/services/importedChats.js');
    const session = driver.session();
    await service.ensureImportedChatSchema(session);
    const tx = session.beginTransaction();
    try {
      await deleteImportedChatsForUser(tx, alice);
      const payload = JSON.parse(readFileSync(new URL('./fixtures/importedChat.synthetic.json', import.meta.url), 'utf8'));
      payload.source.accountKey = alice;
      // The importer must wait on the same owner lock as archive cleanup.
      const attempt = service.importChat(alice, payload, { importedBy: 'owner' }).then(
        () => ({ succeeded: true, status: 201 }),
        (error: unknown) => ({ succeeded: false, status: error instanceof service.ImportedChatError ? error.status : 500 }),
      );
      await new Promise(resolve => setTimeout(resolve, 100));
      await tx.run('MATCH (u:User {id: $alice}) DETACH DELETE u', { alice });
      await tx.commit();
      expect(await attempt).toEqual({ succeeded: false, status: 404 });
      const remaining = await session.executeRead(t => exportImportedChatsForUser(t, alice));
      for (const collection of ['chats', 'participants', 'messages', 'facts', 'asks']) expect(remaining[collection]).toEqual([]);
    } finally { await tx.close(); await session.close(); }
  }, 60_000);
});
