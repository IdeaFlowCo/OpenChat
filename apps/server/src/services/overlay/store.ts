import neo4j from 'neo4j-driver';
import type { Driver, ManagedTransaction } from 'neo4j-driver';
import { nanoid } from 'nanoid';
import {
  cleanKind, cleanName, cleanRef, cleanRelation, cleanText, EMPTY_CARD, fail, intervalAfterContact, isId, isOwnerKey,
  LIMITS, nameKey, nextDue, OverlayError,
} from './contract.js';
import type { Card, CardPatch, DueEntity, Entity, EntityDetail, EntityKind, Link, Note, OverlayPrincipal } from './contract.js';

/**
 * Every read and write is anchored on the owner key; that is the whole privacy
 * model. It therefore holds only in a database that offers nobody
 * caller-written queries.
 *
 * Kept in step with `src/overlay/store.ts` in the Noos repository, which owns
 * this layout. Change it there first.
 */
export class OverlayStore {
  private ready = false;
  constructor(private readonly driver: Driver, private readonly database: string) {
    if (!database) throw new Error('Explicit overlay database required');
  }

  async initialize(): Promise<void> {
    const session = this.driver.session({ database: this.database });
    try {
      for (const statement of [
        'CREATE CONSTRAINT overlay_entity_id IF NOT EXISTS FOR (e:OverlayEntity) REQUIRE e.id IS UNIQUE',
        // Entities made by name (no ref) are one per owner, kind and name; ref-bound entities leave nameSlot null.
        'CREATE CONSTRAINT overlay_entity_name IF NOT EXISTS FOR (e:OverlayEntity) REQUIRE (e.ownerKey, e.nameSlot) IS UNIQUE',
        'CREATE CONSTRAINT overlay_ref_key IF NOT EXISTS FOR (r:OverlayRef) REQUIRE (r.ownerKey, r.ref) IS UNIQUE',
        'CREATE CONSTRAINT overlay_note_id IF NOT EXISTS FOR (n:OverlayNote) REQUIRE n.id IS UNIQUE',
        'CREATE CONSTRAINT overlay_link_key IF NOT EXISTS FOR ()-[l:OVERLAY_LINK]-() REQUIRE l.linkKey IS UNIQUE',
        'CREATE INDEX overlay_entity_owner IF NOT EXISTS FOR (e:OverlayEntity) ON (e.ownerKey, e.kind, e.nameKey)',
        'CREATE INDEX overlay_note_entity IF NOT EXISTS FOR (n:OverlayNote) ON (n.ownerKey, n.entityId)',
        'CREATE INDEX overlay_ref_ref IF NOT EXISTS FOR (r:OverlayRef) ON (r.ref)',
        'CREATE INDEX overlay_link_id IF NOT EXISTS FOR ()-[l:OVERLAY_LINK]-() ON (l.id)',
      ]) await session.run(statement);
    } finally { await session.close(); }
    this.ready = true;
  }

  private owner(principal: OverlayPrincipal | null): string {
    if (!this.ready) fail(503, 'overlay_unavailable');
    if (!principal || !isOwnerKey(principal.ownerKey)) return fail(401, 'authentication_required');
    return principal.ownerKey;
  }
  private async read<T>(work: (tx: ManagedTransaction) => Promise<T>): Promise<T> {
    const session = this.driver.session({ database: this.database, defaultAccessMode: neo4j.session.READ });
    try { return await session.executeRead(work); } finally { await session.close(); }
  }
  private async write<T>(work: (tx: ManagedTransaction) => Promise<T>): Promise<T> {
    const session = this.driver.session({ database: this.database });
    try { return await session.executeWrite(work); } finally { await session.close(); }
  }

  /** The entity a ref points at for this owner, or null. Never creates anything. */
  async lookup(principal: OverlayPrincipal | null, rawRef: unknown): Promise<EntityDetail | null> {
    const ownerKey = this.owner(principal), ref = cleanRef(rawRef);
    return this.read(async tx => {
      const found = await tx.run('MATCH (r:OverlayRef {ownerKey: $ownerKey, ref: $ref}) RETURN r.entityId AS id', { ownerKey, ref });
      const id = found.records[0]?.get('id') as string | undefined;
      return id ? detail(tx, ownerKey, id) : null;
    });
  }

  async get(principal: OverlayPrincipal | null, id: unknown): Promise<EntityDetail> {
    const ownerKey = this.owner(principal);
    if (!isId(id)) return fail(404, 'not_found');
    return this.read(tx => detail(tx, ownerKey, id));
  }

  /**
   * Find or create. With a ref, the entity is the one that ref names for this
   * owner (its display name follows the view). Without one, it is the owner's
   * single entity of that kind and name.
   */
  async ensure(principal: OverlayPrincipal | null, input: { kind?: unknown; name?: unknown; ref?: unknown }): Promise<{ entity: Entity; created: boolean }> {
    const ownerKey = this.owner(principal), kind = cleanKind(input?.kind), name = cleanName(input?.name);
    const ref = input.ref === undefined || input.ref === null ? null : cleanRef(input.ref);
    const attempt = () => this.write(async tx => {
      const now = new Date().toISOString();
      if (ref) {
        const bound = await tx.run('MATCH (r:OverlayRef {ownerKey: $ownerKey, ref: $ref}) RETURN r.entityId AS id', { ownerKey, ref });
        const existingId = bound.records[0]?.get('id') as string | undefined;
        if (existingId) {
          const current = await entity(tx, ownerKey, existingId);
          if (current.kind !== kind) fail(409, 'kind_conflict');
          if (current.name !== name) await tx.run('MATCH (e:OverlayEntity {id: $id, ownerKey: $ownerKey}) SET e.name = $name, e.nameKey = $nameKey, e.updatedAt = $now', { id: existingId, ownerKey, name, nameKey: nameKey(name), now });
          return { entity: { ...current, name }, created: false };
        }
      } else {
        const named = await tx.run('MATCH (e:OverlayEntity {ownerKey: $ownerKey, nameSlot: $slot}) RETURN e.id AS id', { ownerKey, slot: nameSlot(kind, name) });
        const existingId = named.records[0]?.get('id') as string | undefined;
        if (existingId) return { entity: await entity(tx, ownerKey, existingId), created: false };
      }
      await limit(tx, 'MATCH (e:OverlayEntity {ownerKey: $ownerKey}) RETURN count(e) AS total', ownerKey, LIMITS.entitiesPerOwner, 'entity_limit');
      const id = nanoid();
      await tx.run(`CREATE (e:OverlayEntity {id: $id, ownerKey: $ownerKey, kind: $kind, name: $name, nameKey: $nameKey, nameSlot: $slot,
        audience: 'owner', important: false, cadenceMode: 'fixed', createdAt: $now, updatedAt: $now})
        FOREACH (value IN CASE WHEN $ref IS NULL THEN [] ELSE [$ref] END |
          CREATE (:OverlayRef {ownerKey: $ownerKey, ref: value, entityId: $id})-[:REF_OF]->(e))`,
      { id, ownerKey, kind, name, nameKey: nameKey(name), slot: ref ? null : nameSlot(kind, name), ref, now });
      return { entity: { id, kind, name, refs: ref ? [ref] : [], card: { ...EMPTY_CARD } }, created: true };
    });
    // Two first writes for the same ref or name can race; the loser finds the winner's entity on a second pass.
    try { return await attempt(); }
    catch (error) {
      if ((error as { code?: string })?.code !== 'Neo.ClientError.Schema.ConstraintValidationFailed') throw error;
      return attempt();
    }
  }

  /** Rename, attach another ref, or change the card (importance and cadence). */
  async update(principal: OverlayPrincipal | null, id: unknown, patch: { name?: unknown; addRef?: unknown; card?: CardPatch }): Promise<Entity> {
    const ownerKey = this.owner(principal);
    if (!isId(id)) return fail(404, 'not_found');
    const name = patch.name === undefined ? undefined : cleanName(patch.name);
    const addRef = patch.addRef === undefined ? undefined : cleanRef(patch.addRef);
    if (name === undefined && addRef === undefined && !patch.card) return fail(400, 'nothing_to_change');
    return this.write(async tx => {
      const current = await entity(tx, ownerKey, id), now = new Date().toISOString();
      if (name !== undefined && name !== current.name) {
        const slot = current.refs.length ? null : nameSlot(current.kind, name);
        if (slot) {
          const clash = await tx.run('MATCH (e:OverlayEntity {ownerKey: $ownerKey, nameSlot: $slot}) WHERE e.id <> $id RETURN e.id AS id', { ownerKey, slot, id });
          if (clash.records.length) fail(409, 'name_conflict');
        }
        await tx.run('MATCH (e:OverlayEntity {id: $id, ownerKey: $ownerKey}) SET e.name = $name, e.nameKey = $nameKey, e.nameSlot = $slot, e.updatedAt = $now', { id, ownerKey, name, nameKey: nameKey(name), slot, now });
      }
      if (addRef !== undefined && !current.refs.includes(addRef)) {
        if (current.refs.length >= LIMITS.refsPerEntity) fail(409, 'ref_limit');
        const bound = await tx.run('MATCH (r:OverlayRef {ownerKey: $ownerKey, ref: $ref}) RETURN r.entityId AS id', { ownerKey, ref: addRef });
        // One ref names one entity per owner. Joining two entities is a separate, explicit act.
        if (bound.records.length) fail(409, 'ref_conflict');
        await tx.run(`MATCH (e:OverlayEntity {id: $id, ownerKey: $ownerKey})
          CREATE (:OverlayRef {ownerKey: $ownerKey, ref: $ref, entityId: $id})-[:REF_OF]->(e)
          SET e.nameSlot = null, e.updatedAt = $now`, { id, ownerKey, ref: addRef, now });
      }
      if (patch.card) await writeCard(tx, ownerKey, id, current.card, patch.card, now);
      return entity(tx, ownerKey, id);
    });
  }

  async addNote(principal: OverlayPrincipal | null, entityId: unknown, rawText: unknown): Promise<Note> {
    const ownerKey = this.owner(principal), text = cleanText(rawText, LIMITS.noteLength, 'invalid_note');
    if (!isId(entityId)) return fail(404, 'not_found');
    return this.write(async tx => {
      await entity(tx, ownerKey, entityId);
      const count = await tx.run('MATCH (n:OverlayNote {ownerKey: $ownerKey, entityId: $entityId}) RETURN count(n) AS total', { ownerKey, entityId });
      if (number(count.records[0]?.get('total')) >= LIMITS.notesPerEntity) fail(409, 'note_limit');
      const note = { id: nanoid(), text, createdAt: new Date().toISOString(), updatedAt: '' };
      note.updatedAt = note.createdAt;
      await tx.run(`MATCH (e:OverlayEntity {id: $entityId, ownerKey: $ownerKey})
        CREATE (:OverlayNote {id: $id, ownerKey: $ownerKey, entityId: $entityId, text: $text, audience: 'owner', createdAt: $createdAt, updatedAt: $updatedAt})-[:NOTE_ABOUT]->(e)`,
      { ...note, ownerKey, entityId });
      return note;
    });
  }

  async updateNote(principal: OverlayPrincipal | null, noteId: unknown, rawText: unknown): Promise<Note> {
    const ownerKey = this.owner(principal), text = cleanText(rawText, LIMITS.noteLength, 'invalid_note');
    if (!isId(noteId)) return fail(404, 'not_found');
    return this.write(async tx => {
      const result = await tx.run(`MATCH (n:OverlayNote {id: $noteId, ownerKey: $ownerKey}) SET n.text = $text, n.updatedAt = $now
        RETURN n { .id, .text, .createdAt, .updatedAt } AS note`, { noteId, ownerKey, text, now: new Date().toISOString() });
      return (result.records[0]?.get('note') as Note | undefined) ?? fail(404, 'not_found');
    });
  }

  async deleteNote(principal: OverlayPrincipal | null, noteId: unknown): Promise<void> {
    const ownerKey = this.owner(principal);
    if (!isId(noteId)) return fail(404, 'not_found');
    await this.write(async tx => {
      const result = await tx.run('MATCH (n:OverlayNote {id: $noteId, ownerKey: $ownerKey}) DETACH DELETE n RETURN count(*) AS removed', { noteId, ownerKey });
      if (!number(result.records[0]?.get('removed'))) fail(404, 'not_found');
    });
  }

  /** A private edge between two of the owner's entities, in the owner's own words. */
  async addLink(principal: OverlayPrincipal | null, fromId: unknown, rawRelation: unknown, toId: unknown): Promise<Link> {
    const ownerKey = this.owner(principal), relation = cleanRelation(rawRelation);
    if (!isId(fromId) || !isId(toId)) return fail(404, 'not_found');
    if (fromId === toId) return fail(400, 'self_link');
    return this.write(async tx => {
      await entity(tx, ownerKey, fromId);
      const other = await entity(tx, ownerKey, toId);
      await limit(tx, 'MATCH (:OverlayEntity {ownerKey: $ownerKey})-[l:OVERLAY_LINK]->() RETURN count(l) AS total', ownerKey, LIMITS.linksPerOwner, 'link_limit');
      const result = await tx.run(`MATCH (a:OverlayEntity {id: $fromId, ownerKey: $ownerKey}), (b:OverlayEntity {id: $toId, ownerKey: $ownerKey})
        SET a._lock = true REMOVE a._lock
        MERGE (a)-[l:OVERLAY_LINK {linkKey: $linkKey}]->(b)
        ON CREATE SET l.id = $id, l.ownerKey = $ownerKey, l.relation = $relation, l.audience = 'owner', l.createdAt = $now
        RETURN l.id AS id, l.createdAt AS createdAt`,
      { fromId, toId, ownerKey, relation, linkKey: JSON.stringify([fromId, relation, toId]), id: nanoid(), now: new Date().toISOString() });
      const record = result.records[0]!;
      return { id: record.get('id') as string, relation, direction: 'out' as const, other: { id: other.id, kind: other.kind, name: other.name, refs: other.refs }, createdAt: record.get('createdAt') as string };
    });
  }

  async deleteLink(principal: OverlayPrincipal | null, linkId: unknown): Promise<void> {
    const ownerKey = this.owner(principal);
    if (!isId(linkId)) return fail(404, 'not_found');
    await this.write(async tx => {
      const result = await tx.run('MATCH ()-[l:OVERLAY_LINK {id: $linkId}]->() WHERE l.ownerKey = $ownerKey DELETE l RETURN count(*) AS removed', { linkId, ownerKey });
      if (!number(result.records[0]?.get('removed'))) fail(404, 'not_found');
    });
  }

  /**
   * An owner action: forget one entity entirely, with its notes, its links in
   * both directions and its refs. Missing and someone else's are both 404.
   */
  async deleteEntity(principal: OverlayPrincipal | null, id: unknown): Promise<{ notesRemoved: number; linksRemoved: number; refsRemoved: number }> {
    const ownerKey = this.owner(principal);
    if (!isId(id)) return fail(404, 'not_found');
    return this.write(tx => deleteEntityIn(tx, ownerKey, id));
  }

  async list(principal: OverlayPrincipal | null, filter: { q?: unknown; kind?: unknown } = {}): Promise<Entity[]> {
    const ownerKey = this.owner(principal);
    const q = typeof filter.q === 'string' ? nameKey(filter.q).slice(0, LIMITS.nameLength) : '';
    const kind = filter.kind === undefined || filter.kind === null || filter.kind === '' ? null : cleanKind(filter.kind);
    return this.read(async tx => {
      const result = await tx.run(`MATCH (e:OverlayEntity {ownerKey: $ownerKey})
        WHERE ($kind IS NULL OR e.kind = $kind) AND ($q = '' OR e.nameKey CONTAINS $q)
        RETURN ${ENTITY} AS entity ORDER BY e.nameKey LIMIT 50`, { ownerKey, q, kind });
      return result.records.map(record => entityFrom(record.get('entity') as Record<string, unknown>));
    });
  }

  /** Entities whose catch-up date has passed, soonest first; important ones lead ties. */
  async due(principal: OverlayPrincipal | null, now = new Date()): Promise<DueEntity[]> {
    const ownerKey = this.owner(principal);
    return this.read(async tx => {
      const result = await tx.run(`MATCH (e:OverlayEntity {ownerKey: $ownerKey}) WHERE e.cadenceDays IS NOT NULL
        RETURN ${ENTITY} AS entity LIMIT 5000`, { ownerKey });
      return result.records.map(record => entityFrom(record.get('entity') as Record<string, unknown>))
        .filter(value => value.card.nextDueAt !== null && Date.parse(value.card.nextDueAt) <= now.getTime())
        .map(value => ({ id: value.id, name: value.name, refs: value.refs, important: value.card.important, nextDueAt: value.card.nextDueAt!, lastContactAt: value.card.lastContactAt }))
        .sort((a, b) => Date.parse(a.nextDueAt) - Date.parse(b.nextDueAt) || Number(b.important) - Number(a.important) || a.name.localeCompare(b.name));
    });
  }

  /** The owner's whole overlay as plain rows. */
  async exportOwner(principal: OverlayPrincipal | null): Promise<{ entities: unknown[]; notes: unknown[]; links: unknown[] }> {
    const ownerKey = this.owner(principal);
    return this.read(async tx => {
      const rows = async (query: string) => (await tx.run(query, { ownerKey })).records.map(record => record.get('row'));
      return {
        entities: await rows(`MATCH (e:OverlayEntity {ownerKey: $ownerKey}) RETURN e { .id, .kind, .name, .important, .cadenceDays, .cadenceMode, .intervalDays, .lastContactAt, .createdAt, .updatedAt, refs: [(r:OverlayRef)-[:REF_OF]->(e) | r.ref] } AS row ORDER BY e.createdAt`),
        notes: await rows('MATCH (n:OverlayNote {ownerKey: $ownerKey}) RETURN n { .id, .entityId, .text, .createdAt, .updatedAt } AS row ORDER BY n.createdAt'),
        links: await rows('MATCH (a:OverlayEntity {ownerKey: $ownerKey})-[l:OVERLAY_LINK]->(b) RETURN { id: l.id, fromId: a.id, relation: l.relation, toId: b.id, createdAt: l.createdAt } AS row ORDER BY l.createdAt'),
      };
    });
  }

  /** Everything the owner keeps. Used when the owner deletes their account. */
  async deleteOwner(principal: OverlayPrincipal | null): Promise<void> {
    const ownerKey = this.owner(principal);
    await this.write(tx => deleteOwnerIn(tx, ownerKey));
  }

  /**
   * Trusted, not an owner action: the same person is now known by a stronger
   * identity (they linked their sign-in), so what they kept under the old key
   * moves to the new one. Refused when the new key already holds anything;
   * joining two overlays is a separate, deliberate act.
   */
  async rekeyOwner(fromKey: string, toKey: string): Promise<{ moved: boolean }> {
    if (!this.ready) fail(503, 'overlay_unavailable');
    if (!isOwnerKey(fromKey) || !isOwnerKey(toKey) || fromKey === toKey) return fail(400, 'invalid_owner');
    return this.write(async tx => {
      const counts = await tx.run(`OPTIONAL MATCH (a:OverlayEntity {ownerKey: $fromKey}) WITH count(a) AS source
        OPTIONAL MATCH (b:OverlayEntity {ownerKey: $toKey}) RETURN source, count(b) AS target`, { fromKey, toKey });
      if (!number(counts.records[0]?.get('source'))) return { moved: false };
      if (number(counts.records[0]?.get('target'))) return fail(409, 'owner_conflict');
      for (const label of ['OverlayNote', 'OverlayRef', 'OverlayEntity']) await tx.run(`MATCH (n:${label} {ownerKey: $fromKey}) SET n.ownerKey = $toKey`, { fromKey, toKey });
      await tx.run('MATCH (:OverlayEntity {ownerKey: $toKey})-[l:OVERLAY_LINK]->() SET l.ownerKey = $toKey', { toKey });
      return { moved: true };
    });
  }

  /**
   * Trusted app-level erasure, not an owner action: the person behind `ref`
   * left the app, so nobody keeps an overlay pointing at that ref. An entity
   * known only by that ref goes with its notes and links; an entity that
   * other refs still name just loses this one.
   */
  async purgeRef(rawRef: unknown): Promise<{ entitiesRemoved: number; refsRemoved: number }> {
    if (!this.ready) fail(503, 'overlay_unavailable');
    const ref = cleanRef(rawRef);
    return this.write(tx => purgeRefIn(tx, ref));
  }
}

/** For callers that must erase inside their own transaction (account deletion). */
export async function deleteOwnerIn(tx: Pick<ManagedTransaction, 'run'>, ownerKey: string): Promise<void> {
  if (!isOwnerKey(ownerKey)) return fail(400, 'invalid_owner');
  for (const label of ['OverlayNote', 'OverlayRef', 'OverlayEntity']) await tx.run(`MATCH (n:${label} {ownerKey: $ownerKey}) DETACH DELETE n`, { ownerKey });
}

/** For callers that remove an entity together with their own records about it, in one transaction. */
export async function deleteEntityIn(tx: Pick<ManagedTransaction, 'run'>, ownerKey: string, id: string): Promise<{ notesRemoved: number; linksRemoved: number; refsRemoved: number }> {
  if (!isOwnerKey(ownerKey)) return fail(400, 'invalid_owner');
  if (!isId(id)) return fail(404, 'not_found');
  // Locks the entity so a concurrent note or link cannot land on it mid-delete.
  const found = await tx.run(`MATCH (e:OverlayEntity {id: $id, ownerKey: $ownerKey}) SET e._lock = true REMOVE e._lock
    RETURN size([(e)-[l:OVERLAY_LINK]-(:OverlayEntity {ownerKey: $ownerKey}) | l]) AS links`, { id, ownerKey });
  if (!found.records.length) return fail(404, 'not_found');
  const notes = await tx.run('MATCH (n:OverlayNote {ownerKey: $ownerKey, entityId: $id}) DETACH DELETE n RETURN count(*) AS removed', { id, ownerKey });
  const refs = await tx.run('MATCH (r:OverlayRef {ownerKey: $ownerKey, entityId: $id}) DETACH DELETE r RETURN count(*) AS removed', { id, ownerKey });
  await tx.run('MATCH (e:OverlayEntity {id: $id, ownerKey: $ownerKey}) DETACH DELETE e', { id, ownerKey });
  return { notesRemoved: number(notes.records[0]?.get('removed')), linksRemoved: number(found.records[0]?.get('links')), refsRemoved: number(refs.records[0]?.get('removed')) };
}

export async function purgeRefIn(tx: Pick<ManagedTransaction, 'run'>, rawRef: unknown): Promise<{ entitiesRemoved: number; refsRemoved: number }> {
  const ref = cleanRef(rawRef);
  const only = await tx.run(`MATCH (r:OverlayRef {ref: $ref})-[:REF_OF]->(e:OverlayEntity)
    WHERE NOT EXISTS { MATCH (other:OverlayRef)-[:REF_OF]->(e) WHERE other.ref <> $ref }
    WITH DISTINCT e
    OPTIONAL MATCH (n:OverlayNote)-[:NOTE_ABOUT]->(e)
    WITH e, e.id AS id, collect(n) AS notes
    FOREACH (note IN notes | DETACH DELETE note)
    DETACH DELETE e
    RETURN count(id) AS removed`, { ref });
  const refs = await tx.run('MATCH (r:OverlayRef {ref: $ref}) DETACH DELETE r RETURN count(*) AS removed', { ref });
  return { entitiesRemoved: number(only.records[0]?.get('removed')), refsRemoved: number(refs.records[0]?.get('removed')) };
}

const nameSlot = (kind: EntityKind, name: string) => `${kind}\n${nameKey(name)}`;
const number = (value: unknown): number => value === null || value === undefined ? 0 : typeof value === 'number' ? value : typeof (value as { toNumber?: () => number }).toNumber === 'function' ? (value as { toNumber: () => number }).toNumber() : Number(value);
const optional = (value: unknown): number | null => value === null || value === undefined ? null : number(value);
const ENTITY = 'e { .id, .kind, .name, .important, .cadenceDays, .cadenceMode, .intervalDays, .lastContactAt, .cadenceSetAt, .createdAt, refs: [(r:OverlayRef)-[:REF_OF]->(e) | r.ref] }';

function entityFrom(value: Record<string, unknown>): Entity {
  const card = {
    important: value.important === true, cadenceDays: optional(value.cadenceDays),
    cadenceMode: value.cadenceMode === 'expanding' ? 'expanding' as const : 'fixed' as const,
    intervalDays: optional(value.intervalDays), lastContactAt: typeof value.lastContactAt === 'string' ? value.lastContactAt : null,
  };
  const anchor = typeof value.cadenceSetAt === 'string' ? value.cadenceSetAt : String(value.createdAt);
  return { id: String(value.id), kind: value.kind as EntityKind, name: String(value.name), refs: (value.refs as string[]).slice().sort(), card: { ...card, nextDueAt: nextDue(card, anchor) } };
}

async function entity(tx: ManagedTransaction, ownerKey: string, id: string): Promise<Entity> {
  const result = await tx.run(`MATCH (e:OverlayEntity {id: $id, ownerKey: $ownerKey}) RETURN ${ENTITY} AS entity`, { id, ownerKey });
  const found = result.records[0]?.get('entity') as Record<string, unknown> | undefined;
  // Missing and someone else's are the same answer.
  return found ? entityFrom(found) : fail(404, 'not_found');
}

async function detail(tx: ManagedTransaction, ownerKey: string, id: string): Promise<EntityDetail> {
  const base = await entity(tx, ownerKey, id);
  const notes = await tx.run(`MATCH (n:OverlayNote {ownerKey: $ownerKey, entityId: $id})
    RETURN n { .id, .text, .createdAt, .updatedAt } AS note ORDER BY n.createdAt DESC LIMIT $limit`, { ownerKey, id, limit: neo4j.int(LIMITS.notesPerEntity) });
  const links = await tx.run(`MATCH (e:OverlayEntity {id: $id, ownerKey: $ownerKey})-[l:OVERLAY_LINK]-(other:OverlayEntity {ownerKey: $ownerKey})
    RETURN l.id AS id, l.relation AS relation, CASE WHEN startNode(l) = e THEN 'out' ELSE 'in' END AS direction, l.createdAt AS createdAt,
      other { .id, .kind, .name, refs: [(r:OverlayRef)-[:REF_OF]->(other) | r.ref] } AS other
    ORDER BY l.createdAt DESC LIMIT 500`, { ownerKey, id });
  return {
    ...base,
    notes: notes.records.map(record => record.get('note') as Note),
    links: links.records.map(record => {
      const other = record.get('other') as { id: string; kind: EntityKind; name: string; refs: string[] };
      return { id: record.get('id') as string, relation: record.get('relation') as string, direction: record.get('direction') as 'out' | 'in', other: { ...other, refs: other.refs.slice().sort() }, createdAt: record.get('createdAt') as string };
    }),
  };
}

async function limit(tx: ManagedTransaction, query: string, ownerKey: string, max: number, code: string): Promise<void> {
  const count = await tx.run(query, { ownerKey });
  if (number(count.records[0]?.get('total')) >= max) fail(409, code);
}

async function writeCard(tx: ManagedTransaction, ownerKey: string, id: string, current: Card, patch: CardPatch, now: string): Promise<void> {
  const next = { important: current.important, cadenceDays: current.cadenceDays, cadenceMode: current.cadenceMode, intervalDays: current.intervalDays, lastContactAt: current.lastContactAt };
  let cadenceChanged = false;
  if (patch.important !== undefined) next.important = patch.important;
  if (patch.cadenceMode !== undefined && patch.cadenceMode !== next.cadenceMode) { next.cadenceMode = patch.cadenceMode; cadenceChanged = true; }
  if (patch.cadenceDays !== undefined && patch.cadenceDays !== next.cadenceDays) { next.cadenceDays = patch.cadenceDays; cadenceChanged = true; }
  // A changed cadence starts again from its base gap.
  if (cadenceChanged) next.intervalDays = next.cadenceDays;
  if (patch.contactedNow) {
    next.intervalDays = intervalAfterContact(next, current.lastContactAt !== null);
    next.lastContactAt = now;
  }
  await tx.run(`MATCH (e:OverlayEntity {id: $id, ownerKey: $ownerKey})
    SET e.important = $important, e.cadenceDays = $cadenceDays, e.cadenceMode = $cadenceMode, e.intervalDays = $intervalDays,
        e.lastContactAt = $lastContactAt, e.updatedAt = $now,
        e.cadenceSetAt = CASE WHEN $cadenceChanged OR e.cadenceSetAt IS NULL THEN $now ELSE e.cadenceSetAt END`,
  { id, ownerKey, now, important: next.important, cadenceMode: next.cadenceMode, lastContactAt: next.lastContactAt, cadenceChanged,
    cadenceDays: next.cadenceDays === null ? null : neo4j.int(next.cadenceDays), intervalDays: next.intervalDays === null ? null : neo4j.int(next.intervalDays) });
}

export { OverlayError };
