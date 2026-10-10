import neo4j from 'neo4j-driver';
import type { Driver, ManagedTransaction } from 'neo4j-driver';
import { nanoid } from 'nanoid';
import {
  cleanDescription, cleanKind, cleanLinkAttributes, cleanName, cleanProvenance, cleanRef, cleanRelation, cleanRelationType, cleanRequestId, cleanText, EMPTY_CARD, fail,
  intervalAfterContact, isId, isOwnerKey, isSeparateRef, LIMITS, nameKey, nextDue, OverlayError, parseLinkPatch, readProvenance, readRelationType, relationTypeOf, separateRef,
} from './contract.js';
import type {
  Candidate, Card, CardPatch, DueEntity, Edge, Entity, EntityDetail, EntityKind, Link, LinkAttributeInput, LinkEnd, LinkPatch, Neighbourhood, Note, OverlayPrincipal,
  Provenance, RelationType, SearchHit, SearchResult,
} from './contract.js';

/**
 * Every read and write is anchored on the owner key; that is the whole privacy
 * model. It therefore holds only in a database that offers nobody
 * caller-written queries (Noos docs/PEOPLE_OVERLAY.md, "Where it may live").
 *
 * The `...In(tx, ownerKey, ...)` functions below are the same operations for a
 * caller that must commit them together with its own records in one
 * transaction (OpenChat's note reviews). They assume `initialize` has run and
 * that the caller verified the owner; they never accept an owner from input.
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
   * single ref-less entity of that kind and name. Apps naming something from
   * a person's words use `resolve`, which never merges same-named entities.
   */
  async ensure(principal: OverlayPrincipal | null, input: { kind?: unknown; name?: unknown; ref?: unknown; description?: unknown }): Promise<{ entity: Entity; created: boolean }> {
    const ownerKey = this.owner(principal), kind = cleanKind(input?.kind), name = cleanName(input?.name), description = cleanDescription(input?.description);
    const ref = input.ref === undefined || input.ref === null ? null : cleanRef(input.ref);
    return retryOnce(() => this.write(tx => ensureIn(tx, ownerKey, { kind, name, ref, description })));
  }

  /**
   * Find or create one entity named by several refs of the same thing, such as
   * an imported LinkedIn contact (`linkedin:in:<hash>`) who also has a
   * published Unlinked profile (`unlinked:person:<id>`). The first ref, in the
   * given order, that already names an entity decides which entity it is; the
   * other refs are attached to it, so a later write through any of them reaches
   * the same entity. A ref that already names a different entity stays where it
   * is (joining two entities is a separate, explicit act) and is returned in
   * `unattached`, as is any ref beyond the per-entity ref limit.
   */
  async ensureRefs(principal: OverlayPrincipal | null, input: { kind?: unknown; name?: unknown; refs?: unknown; description?: unknown }): Promise<{ entity: Entity; created: boolean; unattached: string[] }> {
    const ownerKey = this.owner(principal), kind = cleanKind(input?.kind), name = cleanName(input?.name), description = cleanDescription(input?.description);
    if (!Array.isArray(input.refs) || !input.refs.length || input.refs.length > LIMITS.refsPerEntity) return fail(400, 'invalid_ref');
    const refs = [...new Set(input.refs.map(cleanRef))];
    return retryOnce(() => this.write(tx => ensureRefsIn(tx, ownerKey, { kind, name, refs, description })));
  }

  /**
   * Find or save by name, the way a person names something ("Maya from
   * dinner"). A name is reused only when it names exactly one of the owner's
   * entities of that kind and that one has no ref; two people called Alex are
   * never merged by name. Otherwise 409 `ambiguous_name` with the candidates,
   * and the caller picks one by id or asks for a separate entity with
   * `createNew` plus a `clientRequestId` (retries find the same one).
   */
  async resolve(principal: OverlayPrincipal | null, input: { kind?: unknown; name?: unknown; createNew?: unknown; clientRequestId?: unknown; description?: unknown }): Promise<{ entity: Entity; created: boolean }> {
    const ownerKey = this.owner(principal), target = cleanResolve(input);
    return retryOnce(() => this.write(tx => resolveIn(tx, ownerKey, principal!.app, target)));
  }

  /**
   * Rename, change the one-line description (null clears it), change the kind,
   * attach another ref, or change the card (importance and cadence). The kind
   * changes only for the owner's own entities (no ref, or only a separate-entity
   * ref): an idea can become a project, but an app's account stays the app's
   * kind (409 `kind_fixed`). A rename or kind change that would collide with
   * another entity saved by that name answers 409 `name_conflict`.
   */
  async update(principal: OverlayPrincipal | null, id: unknown, patch: { name?: unknown; addRef?: unknown; card?: CardPatch; description?: unknown; kind?: unknown }): Promise<Entity> {
    const ownerKey = this.owner(principal);
    if (!isId(id)) return fail(404, 'not_found');
    const name = patch.name === undefined ? undefined : cleanName(patch.name);
    const addRef = patch.addRef === undefined ? undefined : cleanRef(patch.addRef);
    const description = patch.description === undefined ? undefined : cleanDescription(patch.description);
    const kind = patch.kind === undefined ? undefined : cleanKind(patch.kind);
    if (name === undefined && addRef === undefined && !patch.card && description === undefined && kind === undefined) return fail(400, 'nothing_to_change');
    return this.write(async tx => {
      const current = await entity(tx, ownerKey, id), now = new Date().toISOString();
      const nextName = name ?? current.name, nextKind = kind ?? current.kind;
      if (nextKind !== current.kind && !current.refs.every(isSeparateRef)) fail(409, 'kind_fixed');
      if (nextName !== current.name || nextKind !== current.kind) {
        const slot = current.refs.length ? null : nameSlot(nextKind, nextName);
        if (slot) {
          const clash = await tx.run('MATCH (e:OverlayEntity {ownerKey: $ownerKey, nameSlot: $slot}) WHERE e.id <> $id RETURN e.id AS id', { ownerKey, slot, id });
          if (clash.records.length) fail(409, 'name_conflict');
        }
        await tx.run('MATCH (e:OverlayEntity {id: $id, ownerKey: $ownerKey}) SET e.name = $name, e.nameKey = $nameKey, e.nameSlot = $slot, e.kind = $kind, e.updatedAt = $now',
          { id, ownerKey, name: nextName, nameKey: nameKey(nextName), slot, kind: nextKind, now });
      }
      if (description !== undefined && description !== current.description) {
        await tx.run('MATCH (e:OverlayEntity {id: $id, ownerKey: $ownerKey}) SET e.description = $description, e.updatedAt = $now', { id, ownerKey, description, now });
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

  /** The same text already on this entity is the same note: a retried write never doubles it. */
  async addNote(principal: OverlayPrincipal | null, entityId: unknown, rawText: unknown, provenance?: unknown): Promise<{ note: Note; created: boolean }> {
    const ownerKey = this.owner(principal), text = cleanText(rawText, LIMITS.noteLength, 'invalid_note'), by = cleanProvenance(provenance);
    if (!isId(entityId)) return fail(404, 'not_found');
    return this.write(tx => addNoteIn(tx, ownerKey, entityId, text, by));
  }

  async updateNote(principal: OverlayPrincipal | null, noteId: unknown, rawText: unknown): Promise<Note> {
    const ownerKey = this.owner(principal), text = cleanText(rawText, LIMITS.noteLength, 'invalid_note');
    if (!isId(noteId)) return fail(404, 'not_found');
    return this.write(async tx => {
      const result = await tx.run(`MATCH (n:OverlayNote {id: $noteId, ownerKey: $ownerKey}) SET n.text = $text, n.updatedAt = $now
        RETURN ${NOTE} AS note`, { noteId, ownerKey, text, now: new Date().toISOString() });
      const found = result.records[0]?.get('note') as Record<string, unknown> | undefined;
      return found ? noteFrom(found) : fail(404, 'not_found');
    });
  }

  async deleteNote(principal: OverlayPrincipal | null, noteId: unknown): Promise<void> {
    const ownerKey = this.owner(principal);
    if (!isId(noteId)) return fail(404, 'not_found');
    await this.write(tx => deleteNoteIn(tx, ownerKey, noteId));
  }

  /**
   * A private edge between two of the owner's entities, in the owner's own
   * words. The same (from, relation, to) is one link: repeating it returns the
   * existing one, with its original provenance and attributes (change those
   * with `updateLink`). `attributes` may name the `relationType` (otherwise
   * derived from the words and the end kinds) and give `since`, `until` and
   * `context`.
   */
  async addLink(principal: OverlayPrincipal | null, fromId: unknown, rawRelation: unknown, toId: unknown, provenance?: unknown, attributes?: unknown): Promise<{ link: Link; created: boolean }> {
    const ownerKey = this.owner(principal), relation = cleanRelation(rawRelation), by = cleanProvenance(provenance), extra = cleanLinkAttributes(attributes);
    if (!isId(fromId) || !isId(toId)) return fail(404, 'not_found');
    return this.write(tx => addLinkIn(tx, ownerKey, fromId, relation, toId, by, extra));
  }

  /**
   * Edit a link in place. `change` is the new relation text (the original
   * form) or a patch `{relation?, relationType?, assertion?, since?, until?,
   * context?}`. Changing the relation ("sister of" to "cousin of") rewrites
   * relation, identity and type together and the editor's provenance replaces
   * the old one; when the owner already has the edited link the two become
   * one, the edited link goes and the existing one is returned with
   * `merged: true` (with any other fields of the patch applied to it).
   * Anything else is a plain edit: the original author stays and the edit is
   * recorded in `updatedAt` and `updatedBy`.
   */
  async updateLink(principal: OverlayPrincipal | null, linkId: unknown, change: unknown, provenance?: unknown): Promise<{ link: Link; merged: boolean }> {
    const ownerKey = this.owner(principal), patch = parseLinkPatch(change), by = cleanProvenance(provenance);
    if (!isId(linkId)) return fail(404, 'not_found');
    return this.write(tx => updateLinkIn(tx, ownerKey, linkId, patch, by));
  }

  async deleteLink(principal: OverlayPrincipal | null, linkId: unknown): Promise<void> {
    const ownerKey = this.owner(principal);
    if (!isId(linkId)) return fail(404, 'not_found');
    await this.write(tx => deleteLinkIn(tx, ownerKey, linkId));
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

  /**
   * Search the owner's overlay: entities by name, description or note text,
   * and links by relation text, context, relation type or either end's name.
   * Bounded; `truncated` says more matched than were returned.
   */
  async search(principal: OverlayPrincipal | null, filter: { q?: unknown; relationType?: unknown; kind?: unknown; limit?: unknown } = {}): Promise<SearchResult> {
    const ownerKey = this.owner(principal);
    const q = typeof filter.q === 'string' ? nameKey(filter.q).slice(0, LIMITS.nameLength) : '';
    const relationType = filter.relationType === undefined || filter.relationType === null || filter.relationType === '' ? null : cleanRelationType(filter.relationType);
    const kind = filter.kind === undefined || filter.kind === null || filter.kind === '' ? null : cleanKind(filter.kind);
    if (!q && !relationType && !kind) return fail(400, 'invalid_query');
    const max = boundedLimit(filter.limit, 50);
    return this.read(async tx => {
      let entities: SearchHit[] = [], truncated = false;
      if (q || (kind && !relationType)) {
        const found = await tx.run(`MATCH (e:OverlayEntity {ownerKey: $ownerKey})
          WHERE ($kind IS NULL OR e.kind = $kind)
          WITH e, ($q = '' OR e.nameKey CONTAINS $q) AS byName,
            ($q <> '' AND toLower(coalesce(e.description, '')) CONTAINS $q) AS byDescription,
            ($q <> '' AND EXISTS { MATCH (n:OverlayNote {ownerKey: $ownerKey, entityId: e.id}) WHERE toLower(n.text) CONTAINS $q }) AS byNote
          WHERE byName OR byDescription OR byNote
          RETURN ${ENTITY} AS entity, byName, byDescription, byNote ORDER BY byName DESC, byDescription DESC, e.nameKey LIMIT $limit`,
        { ownerKey, q, kind, limit: neo4j.int(max + 1) });
        truncated = found.records.length > max;
        entities = found.records.slice(0, max).map(record => ({
          ...entityFrom(record.get('entity') as Record<string, unknown>),
          matched: [...(record.get('byName') && q ? ['name' as const] : []), ...(record.get('byDescription') ? ['description' as const] : []), ...(record.get('byNote') ? ['note' as const] : [])],
        }));
      }
      const links: SearchResult['links'] = [];
      if (q || relationType) {
        const rows = await tx.run(`MATCH (a:OverlayEntity {ownerKey: $ownerKey})-[l:OVERLAY_LINK]->(b:OverlayEntity {ownerKey: $ownerKey})
          WHERE l.ownerKey = $ownerKey AND ($kind IS NULL OR a.kind = $kind OR b.kind = $kind)
          RETURN ${EDGE} AS edge, ${end('a')} AS fromEnd, ${end('b')} AS toEnd ORDER BY l.createdAt DESC LIMIT $cap`,
        { ownerKey, kind, cap: neo4j.int(LIMITS.linksPerOwner) });
        for (const record of rows.records) {
          const edge = edgeFrom(record.get('edge') as Record<string, unknown>);
          const from = endFrom(record.get('fromEnd') as Record<string, unknown>), to = endFrom(record.get('toEnd') as Record<string, unknown>);
          if (relationType && edge.relationType !== relationType) continue;
          if (q && ![edge.relation, from.name, to.name, edge.context ?? ''].some(value => nameKey(value).includes(q))) continue;
          if (links.length >= max) { truncated = true; break; }
          links.push({ ...edge, fromId: from.id, toId: to.id, from, to });
        }
      }
      return { entities, links, truncated };
    });
  }

  /** An entity and the links around it, one or two hops out, bounded. */
  async neighbourhood(principal: OverlayPrincipal | null, id: unknown, rawDepth: unknown = 1): Promise<Neighbourhood> {
    const ownerKey = this.owner(principal);
    if (!isId(id)) return fail(404, 'not_found');
    const depth = rawDepth === undefined || rawDepth === null || rawDepth === '' || rawDepth === 1 || rawDepth === '1' ? 1 : rawDepth === 2 || rawDepth === '2' ? 2 : fail(400, 'invalid_depth');
    return this.read(async tx => {
      const center = await entity(tx, ownerKey, id);
      const entities = new Map<string, Entity>(), links = new Map<string, Edge>();
      let truncated = false, frontier = [center.id];
      const seen = new Set([center.id]);
      for (let hop = 1; hop <= depth && frontier.length; hop++) {
        const rows = await tx.run(`MATCH (x:OverlayEntity {ownerKey: $ownerKey}) WHERE x.id IN $ids
          MATCH (x)-[l:OVERLAY_LINK]-(e:OverlayEntity {ownerKey: $ownerKey}) WHERE l.ownerKey = $ownerKey
          RETURN DISTINCT ${EDGE} AS edge, startNode(l).id AS fromId, endNode(l).id AS toId, ${ENTITY} AS entity
          ORDER BY edge.createdAt DESC LIMIT $limit`,
        { ownerKey, ids: frontier, limit: neo4j.int(NEIGHBOURHOOD.links + 1) });
        const next: string[] = [];
        for (const record of rows.records) {
          const edge = { ...edgeFrom(record.get('edge') as Record<string, unknown>), fromId: String(record.get('fromId')), toId: String(record.get('toId')) };
          if (links.has(edge.id)) continue;
          const other = entityFrom(record.get('entity') as Record<string, unknown>);
          if (links.size >= NEIGHBOURHOOD.links || (!seen.has(other.id) && entities.size >= NEIGHBOURHOOD.entities)) { truncated = true; continue; }
          links.set(edge.id, edge);
          if (!seen.has(other.id)) { seen.add(other.id); entities.set(other.id, other); next.push(other.id); }
        }
        if (rows.records.length > NEIGHBOURHOOD.links) truncated = true;
        frontier = next;
      }
      return { center, depth, entities: [...entities.values()], links: [...links.values()], truncated };
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
        entities: await rows(`MATCH (e:OverlayEntity {ownerKey: $ownerKey}) RETURN e { .id, .kind, .name, .description, .important, .cadenceDays, .cadenceMode, .intervalDays, .lastContactAt, .createdAt, .updatedAt, refs: [(r:OverlayRef)-[:REF_OF]->(e) | r.ref] } AS row ORDER BY e.createdAt`),
        notes: await rows('MATCH (n:OverlayNote {ownerKey: $ownerKey}) RETURN n { .id, .entityId, .text, .createdAt, .updatedAt, .author, .source, .assertion } AS row ORDER BY n.createdAt'),
        links: (await rows(`MATCH (a:OverlayEntity {ownerKey: $ownerKey})-[l:OVERLAY_LINK]->(b) RETURN { id: l.id, fromId: a.id, relation: l.relation, relationType: l.relationType, toId: b.id,
          createdAt: l.createdAt, updatedAt: l.updatedAt, updatedBy: l.updatedBy, author: l.author, source: l.source, assertion: l.assertion, since: l.since, until: l.until, context: l.context } AS row ORDER BY l.createdAt`))
          .map(row => ({ ...(row as Record<string, unknown>), relationType: storedRelationType(row as Record<string, unknown>) })),
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

/** For callers that remove an entity together with their own records about it, in one transaction. */
export async function deleteEntityIn(tx: Runner, ownerKey: string, id: string): Promise<{ notesRemoved: number; linksRemoved: number; refsRemoved: number }> {
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

/**
 * `ensure` inside the caller's transaction. Inputs must already be cleaned. A
 * `description` is stored on a new entity, and fills an existing entity's
 * blank one; it never replaces a description already there.
 */
export async function ensureIn(tx: Runner, ownerKey: string, input: { kind: EntityKind; name: string; ref: string | null; description?: string | null }): Promise<{ entity: Entity; created: boolean }> {
  if (!isOwnerKey(ownerKey)) return fail(400, 'invalid_owner');
  const { kind, name, ref } = input, description = input.description ?? null, now = new Date().toISOString();
  let existingId: string | undefined;
  if (ref) {
    const bound = await tx.run('MATCH (r:OverlayRef {ownerKey: $ownerKey, ref: $ref}) RETURN r.entityId AS id', { ownerKey, ref });
    existingId = bound.records[0]?.get('id') as string | undefined;
    if (existingId) {
      const current = await entity(tx, ownerKey, existingId);
      if (current.kind !== kind) fail(409, 'kind_conflict');
      if (current.name !== name) await tx.run('MATCH (e:OverlayEntity {id: $id, ownerKey: $ownerKey}) SET e.name = $name, e.nameKey = $nameKey, e.updatedAt = $now', { id: existingId, ownerKey, name, nameKey: nameKey(name), now });
    }
  } else {
    const named = await tx.run('MATCH (e:OverlayEntity {ownerKey: $ownerKey, nameSlot: $slot}) RETURN e.id AS id', { ownerKey, slot: nameSlot(kind, name) });
    existingId = named.records[0]?.get('id') as string | undefined;
  }
  if (existingId) {
    if (description !== null) await tx.run('MATCH (e:OverlayEntity {id: $id, ownerKey: $ownerKey}) WHERE e.description IS NULL SET e.description = $description, e.updatedAt = $now', { id: existingId, ownerKey, description, now });
    return { entity: await entity(tx, ownerKey, existingId), created: false };
  }
  await limit(tx, 'MATCH (e:OverlayEntity {ownerKey: $ownerKey}) RETURN count(e) AS total', ownerKey, LIMITS.entitiesPerOwner, 'entity_limit');
  const id = nanoid();
  await tx.run(`CREATE (e:OverlayEntity {id: $id, ownerKey: $ownerKey, kind: $kind, name: $name, nameKey: $nameKey, nameSlot: $slot, description: $description,
    audience: 'owner', important: false, cadenceMode: 'fixed', createdAt: $now, updatedAt: $now})
    FOREACH (value IN CASE WHEN $ref IS NULL THEN [] ELSE [$ref] END |
      CREATE (:OverlayRef {ownerKey: $ownerKey, ref: value, entityId: $id})-[:REF_OF]->(e))`,
  { id, ownerKey, kind, name, nameKey: nameKey(name), slot: ref ? null : nameSlot(kind, name), description, ref, now });
  return { entity: { id, kind, name, description, refs: ref ? [ref] : [], card: { ...EMPTY_CARD } }, created: true };
}

/** `ensureRefs` inside the caller's transaction. Inputs must already be cleaned (refs deduplicated, at least one). */
export async function ensureRefsIn(tx: Runner, ownerKey: string, input: { kind: EntityKind; name: string; refs: string[]; description?: string | null }): Promise<{ entity: Entity; created: boolean; unattached: string[] }> {
  if (!isOwnerKey(ownerKey)) return fail(400, 'invalid_owner');
  const { kind, name, refs, description } = input;
  const found = await tx.run('UNWIND $refs AS ref OPTIONAL MATCH (r:OverlayRef {ownerKey: $ownerKey, ref: ref}) RETURN ref, r.entityId AS id', { ownerKey, refs });
  const boundTo = new Map(found.records.map(record => [String(record.get('ref')), (record.get('id') as string | null) ?? null]));
  const primary = refs.find(ref => boundTo.get(ref)) ?? refs[0]!;
  const { entity: current, created } = await ensureIn(tx, ownerKey, { kind, name, ref: primary, description });
  const unattached: string[] = [], now = new Date().toISOString();
  let count = current.refs.length;
  for (const ref of refs) {
    const owner = boundTo.get(ref);
    if (ref === primary || owner === current.id) continue;
    if (owner || count >= LIMITS.refsPerEntity) { unattached.push(ref); continue; }
    await tx.run(`MATCH (e:OverlayEntity {id: $id, ownerKey: $ownerKey})
      CREATE (:OverlayRef {ownerKey: $ownerKey, ref: $ref, entityId: $id})-[:REF_OF]->(e)
      SET e.nameSlot = null, e.updatedAt = $now`, { id: current.id, ownerKey, ref, now });
    count++;
  }
  return { entity: await entity(tx, ownerKey, current.id), created, unattached };
}

export interface ResolveTarget { kind: EntityKind; name: string; requestId: string | null; description?: string | null }
export function cleanResolve(input: { kind?: unknown; name?: unknown; createNew?: unknown; clientRequestId?: unknown; description?: unknown }): ResolveTarget {
  const kind = cleanKind(input?.kind), name = cleanName(input?.name), description = cleanDescription(input?.description);
  if (input.createNew === undefined || input.createNew === null || input.createNew === false) return { kind, name, requestId: null, description };
  // A deliberately separate entity needs a request id so a retry finds it instead of making a third.
  if (input.createNew !== true) return fail(400, 'invalid_create_new');
  return { kind, name, requestId: cleanRequestId(input.clientRequestId), description };
}

/** `resolve` inside the caller's transaction; `app` scopes the ref of a separate entity. */
export async function resolveIn(tx: Runner, ownerKey: string, app: string, target: ResolveTarget): Promise<{ entity: Entity; created: boolean }> {
  const description = target.description ?? null;
  if (target.requestId !== null) return ensureIn(tx, ownerKey, { kind: target.kind, name: target.name, ref: separateRef(app, target.requestId), description });
  const found = await tx.run(`MATCH (e:OverlayEntity {ownerKey: $ownerKey, kind: $kind, nameKey: $nameKey})
    RETURN e.id AS id, e.name AS name, e.description AS description, [(r:OverlayRef)-[:REF_OF]->(e) | r.ref] AS refs ORDER BY e.createdAt LIMIT 20`,
  { ownerKey, kind: target.kind, nameKey: nameKey(target.name) });
  const matches: Candidate[] = found.records.map(record => ({
    id: String(record.get('id')), kind: target.kind, name: String(record.get('name')),
    description: typeof record.get('description') === 'string' ? record.get('description') as string : null, refs: ((record.get('refs') as string[]) ?? []).slice().sort(),
  }));
  if (!matches.length) return ensureIn(tx, ownerKey, { kind: target.kind, name: target.name, ref: null, description });
  if (matches.length === 1 && matches[0]!.refs.length === 0) {
    const id = matches[0]!.id;
    if (description !== null) await tx.run('MATCH (e:OverlayEntity {id: $id, ownerKey: $ownerKey}) WHERE e.description IS NULL SET e.description = $description, e.updatedAt = $now', { id, ownerKey, description, now: new Date().toISOString() });
    return { entity: await entity(tx, ownerKey, id), created: false };
  }
  return fail(409, 'ambiguous_name', { candidates: matches });
}

/** `addNote` inside the caller's transaction. */
export async function addNoteIn(tx: Runner, ownerKey: string, entityId: string, rawText: string, provenance: Provenance): Promise<{ note: Note; created: boolean }> {
  if (!isOwnerKey(ownerKey)) return fail(400, 'invalid_owner');
  if (!isId(entityId)) return fail(404, 'not_found');
  const text = cleanText(rawText, LIMITS.noteLength, 'invalid_note');
  // Locks the entity: two identical notes racing still become one.
  const locked = await tx.run('MATCH (e:OverlayEntity {id: $entityId, ownerKey: $ownerKey}) SET e._lock = true REMOVE e._lock RETURN e.id AS id', { entityId, ownerKey });
  if (!locked.records.length) return fail(404, 'not_found');
  const same = await tx.run(`MATCH (n:OverlayNote {ownerKey: $ownerKey, entityId: $entityId}) WHERE n.text = $text RETURN ${NOTE} AS note ORDER BY n.createdAt LIMIT 1`, { ownerKey, entityId, text });
  if (same.records.length) return { note: noteFrom(same.records[0]!.get('note') as Record<string, unknown>), created: false };
  const count = await tx.run('MATCH (n:OverlayNote {ownerKey: $ownerKey, entityId: $entityId}) RETURN count(n) AS total', { ownerKey, entityId });
  if (number(count.records[0]?.get('total')) >= LIMITS.notesPerEntity) fail(409, 'note_limit');
  const now = new Date().toISOString();
  const note: Note = { id: nanoid(), text, createdAt: now, updatedAt: now, ...provenance };
  await tx.run(`MATCH (e:OverlayEntity {id: $entityId, ownerKey: $ownerKey})
    CREATE (:OverlayNote {id: $id, ownerKey: $ownerKey, entityId: $entityId, text: $text, audience: 'owner', createdAt: $createdAt, updatedAt: $updatedAt,
      author: $author, source: $source, assertion: $assertion})-[:NOTE_ABOUT]->(e)`,
  { ...note, ownerKey, entityId });
  return { note, created: true };
}

export async function deleteNoteIn(tx: Runner, ownerKey: string, noteId: string): Promise<void> {
  if (!isOwnerKey(ownerKey)) return fail(400, 'invalid_owner');
  if (!isId(noteId)) return fail(404, 'not_found');
  const result = await tx.run('MATCH (n:OverlayNote {id: $noteId, ownerKey: $ownerKey}) DETACH DELETE n RETURN count(*) AS removed', { noteId, ownerKey });
  if (!number(result.records[0]?.get('removed'))) fail(404, 'not_found');
}

/** `addLink` inside the caller's transaction. `attributes` as for `addLink` (cleaned again here). */
export async function addLinkIn(tx: Runner, ownerKey: string, fromId: string, rawRelation: string, toId: string, provenance: Provenance, attributes: LinkAttributeInput = {}): Promise<{ link: Link; created: boolean }> {
  if (!isOwnerKey(ownerKey)) return fail(400, 'invalid_owner');
  const relation = cleanRelation(rawRelation), extra = cleanLinkAttributes(attributes);
  if (!isId(fromId) || !isId(toId)) return fail(404, 'not_found');
  if (fromId === toId) return fail(400, 'self_link');
  // Locks the subject, so the limit check and the write see the same links.
  const locked = await tx.run('MATCH (a:OverlayEntity {id: $fromId, ownerKey: $ownerKey}) SET a._lock = true REMOVE a._lock RETURN a.kind AS kind', { fromId, ownerKey });
  if (!locked.records.length) return fail(404, 'not_found');
  const fromKind = locked.records[0]!.get('kind') as EntityKind;
  const other = await entity(tx, ownerKey, toId);
  const linkKey = JSON.stringify([fromId, relation, toId]);
  const existing = await tx.run(`MATCH (:OverlayEntity {id: $fromId, ownerKey: $ownerKey})-[l:OVERLAY_LINK {linkKey: $linkKey}]->(:OverlayEntity {id: $toId, ownerKey: $ownerKey}) RETURN ${EDGE} AS edge`, { fromId, toId, ownerKey, linkKey });
  if (existing.records.length) return { link: linkFrom(edgeFrom(existing.records[0]!.get('edge') as Record<string, unknown>), 'out', other), created: false };
  await limit(tx, 'MATCH (:OverlayEntity {ownerKey: $ownerKey})-[l:OVERLAY_LINK]->() RETURN count(l) AS total', ownerKey, LIMITS.linksPerOwner, 'link_limit');
  const now = new Date().toISOString(), id = nanoid(), relationType = extra.relationType ?? relationTypeOf(relation, fromKind, other.kind);
  const result = await tx.run(`MATCH (a:OverlayEntity {id: $fromId, ownerKey: $ownerKey}), (b:OverlayEntity {id: $toId, ownerKey: $ownerKey})
    MERGE (a)-[l:OVERLAY_LINK {linkKey: $linkKey}]->(b)
    ON CREATE SET l.id = $id, l.ownerKey = $ownerKey, l.relation = $relation, l.relationType = $relationType, l.audience = 'owner', l.createdAt = $now,
      l.author = $author, l.source = $source, l.assertion = $assertion, l.since = $since, l.until = $until, l.context = $context
    RETURN ${EDGE} AS edge`,
  { fromId, toId, ownerKey, relation, relationType, linkKey, id, now, ...provenance, since: extra.since ?? null, until: extra.until ?? null, context: extra.context ?? null });
  return { link: linkFrom(edgeFrom(result.records[0]!.get('edge') as Record<string, unknown>), 'out', other), created: true };
}

/** `updateLink` inside the caller's transaction. `change` is the new relation text or a link patch (cleaned again here). */
export async function updateLinkIn(tx: Runner, ownerKey: string, linkId: string, change: string | LinkPatch, provenance: Provenance): Promise<{ link: Link; merged: boolean }> {
  if (!isOwnerKey(ownerKey)) return fail(400, 'invalid_owner');
  if (!isId(linkId)) return fail(404, 'not_found');
  const patch = parseLinkPatch(change);
  const found = await tx.run(`MATCH (a:OverlayEntity {ownerKey: $ownerKey})-[l:OVERLAY_LINK {id: $linkId}]->(b:OverlayEntity {ownerKey: $ownerKey})
    WHERE l.ownerKey = $ownerKey SET a._lock = true REMOVE a._lock RETURN a.id AS fromId, b.id AS toId, a.kind AS fromKind, l.relation AS relation`, { ownerKey, linkId });
  const row = found.records[0];
  if (!row) return fail(404, 'not_found');
  const fromId = String(row.get('fromId')), toId = String(row.get('toId')), fromKind = row.get('fromKind') as EntityKind, other = await entity(tx, ownerKey, toId);
  const now = new Date().toISOString();
  // Fields edited in place; a null value removes the property (reads back as null).
  const inPlace = (relation: string): Record<string, unknown> => {
    const values: Record<string, unknown> = {};
    for (const key of ['since', 'until', 'context'] as const) if (patch[key] !== undefined) values[key] = patch[key];
    if (patch.relationType !== undefined) values.relationType = patch.relationType ?? relationTypeOf(relation, fromKind, other.kind);
    if (patch.assertion !== undefined) values.assertion = patch.assertion;
    return values;
  };
  const read = async (query: string, parameters: Record<string, unknown>) => linkFrom(edgeFrom((await tx.run(query, parameters)).records[0]!.get('edge') as Record<string, unknown>), 'out', other);
  const currentRelation = String(row.get('relation'));
  if (patch.relation === undefined || patch.relation === currentRelation) {
    const values = inPlace(currentRelation);
    const touched = Object.keys(values).length ? { ...values, updatedAt: now, updatedBy: provenance.author } : {};
    return { link: await read(`MATCH ()-[l:OVERLAY_LINK {id: $linkId}]->() WHERE l.ownerKey = $ownerKey SET l += $touched RETURN ${EDGE} AS edge`, { linkId, ownerKey, touched }), merged: false };
  }
  const relation = patch.relation, linkKey = JSON.stringify([fromId, relation, toId]);
  const clash = await tx.run(`MATCH (:OverlayEntity {id: $fromId, ownerKey: $ownerKey})-[m:OVERLAY_LINK {linkKey: $linkKey}]->(:OverlayEntity {id: $toId, ownerKey: $ownerKey})
    WHERE m.id <> $linkId RETURN m.id AS id`, { fromId, toId, ownerKey, linkKey, linkId });
  if (clash.records.length) {
    // The edited link would be one the owner already has: keep that one, with the rest of the edit applied.
    await tx.run('MATCH ()-[l:OVERLAY_LINK {id: $linkId}]->() WHERE l.ownerKey = $ownerKey DELETE l', { linkId, ownerKey });
    const values = inPlace(relation);
    const touched = Object.keys(values).length ? { ...values, updatedAt: now, updatedBy: provenance.author } : {};
    return { link: await read(`MATCH ()-[l:OVERLAY_LINK {id: $survivor}]->() WHERE l.ownerKey = $ownerKey SET l += $touched RETURN ${EDGE} AS edge`, { survivor: String(clash.records[0]!.get('id')), ownerKey, touched }), merged: true };
  }
  const values = { ...inPlace(relation), relation, linkKey, relationType: patch.relationType ?? relationTypeOf(relation, fromKind, other.kind),
    updatedAt: now, updatedBy: provenance.author, author: provenance.author, source: provenance.source, assertion: patch.assertion ?? provenance.assertion };
  return { link: await read(`MATCH ()-[l:OVERLAY_LINK {id: $linkId}]->() WHERE l.ownerKey = $ownerKey SET l += $values RETURN ${EDGE} AS edge`, { linkId, ownerKey, values }), merged: false };
}

export async function deleteLinkIn(tx: Runner, ownerKey: string, linkId: string): Promise<void> {
  if (!isOwnerKey(ownerKey)) return fail(400, 'invalid_owner');
  if (!isId(linkId)) return fail(404, 'not_found');
  const result = await tx.run('MATCH ()-[l:OVERLAY_LINK {id: $linkId}]->() WHERE l.ownerKey = $ownerKey DELETE l RETURN count(*) AS removed', { linkId, ownerKey });
  if (!number(result.records[0]?.get('removed'))) fail(404, 'not_found');
}

type Runner = Pick<ManagedTransaction, 'run'>;
const NEIGHBOURHOOD = { entities: 100, links: 200 } as const;
const nameSlot = (kind: EntityKind, name: string) => `${kind}\n${nameKey(name)}`;
const number = (value: unknown): number => value === null || value === undefined ? 0 : typeof value === 'number' ? value : typeof (value as { toNumber?: () => number }).toNumber === 'function' ? (value as { toNumber: () => number }).toNumber() : Number(value);
const optional = (value: unknown): number | null => value === null || value === undefined ? null : number(value);
const boundedLimit = (value: unknown, max: number): number => {
  const parsed = typeof value === 'string' && /^\d{1,3}$/.test(value) ? Number(value) : value;
  return typeof parsed === 'number' && Number.isInteger(parsed) && parsed >= 1 ? Math.min(parsed, max) : max;
};
/** Two first writes for the same ref or name can race; the loser finds the winner's entity on a second pass. */
async function retryOnce<T>(attempt: () => Promise<T>): Promise<T> {
  try { return await attempt(); }
  catch (error) {
    if ((error as { code?: string })?.code !== 'Neo.ClientError.Schema.ConstraintValidationFailed') throw error;
    return attempt();
  }
}
const ENTITY = 'e { .id, .kind, .name, .description, .important, .cadenceDays, .cadenceMode, .intervalDays, .lastContactAt, .cadenceSetAt, .createdAt, refs: [(r:OverlayRef)-[:REF_OF]->(e) | r.ref] }';
const NOTE = 'n { .id, .text, .createdAt, .updatedAt, .author, .source, .assertion }';
const edge = (name: string) => `${name} { .id, .relation, .relationType, .createdAt, .updatedAt, .updatedBy, .author, .source, .assertion, .since, .until, .context }`;
const EDGE = edge('l');
const end = (name: string) => `${name} { .id, .kind, .name, refs: [(r:OverlayRef)-[:REF_OF]->(${name}) | r.ref] }`;

function noteFrom(value: Record<string, unknown>): Note {
  return { id: String(value.id), text: String(value.text), createdAt: String(value.createdAt), updatedAt: String(value.updatedAt ?? value.createdAt), ...readProvenance(value) };
}
/**
 * The stored type; the retired `other` reads as `related`. Links written
 * before relation types existed are typed from their words alone, exactly as
 * they always read (not from their end kinds), so existing data reads unchanged.
 */
function storedRelationType(value: Record<string, unknown>): RelationType {
  return readRelationType(value.relationType, String(value.relation ?? ''));
}
const textOrNull = (value: unknown): string | null => typeof value === 'string' && value ? value : null;
function edgeFrom(value: Record<string, unknown>): Omit<Edge, 'fromId' | 'toId'> & { fromId: string; toId: string } {
  return {
    id: String(value.id), relation: String(value.relation), relationType: storedRelationType(value), fromId: '', toId: '',
    createdAt: String(value.createdAt), updatedAt: textOrNull(value.updatedAt), updatedBy: textOrNull(value.updatedBy), ...readProvenance(value),
    since: textOrNull(value.since), until: textOrNull(value.until), context: textOrNull(value.context),
  };
}
function endFrom(value: Record<string, unknown>): LinkEnd {
  return { id: String(value.id), kind: value.kind as EntityKind, name: String(value.name), refs: ((value.refs as string[]) ?? []).slice().sort() };
}
function linkFrom(edge: Omit<Edge, 'fromId' | 'toId'>, direction: 'out' | 'in', other: LinkEnd | Entity): Link {
  return {
    id: edge.id, relation: edge.relation, relationType: edge.relationType, direction,
    other: { id: other.id, kind: other.kind, name: other.name, refs: other.refs.slice().sort() },
    createdAt: edge.createdAt, updatedAt: edge.updatedAt, updatedBy: edge.updatedBy, author: edge.author, source: edge.source, assertion: edge.assertion,
    since: edge.since, until: edge.until, context: edge.context,
  };
}

function entityFrom(value: Record<string, unknown>): Entity {
  const card = {
    important: value.important === true, cadenceDays: optional(value.cadenceDays),
    cadenceMode: value.cadenceMode === 'expanding' ? 'expanding' as const : 'fixed' as const,
    intervalDays: optional(value.intervalDays), lastContactAt: typeof value.lastContactAt === 'string' ? value.lastContactAt : null,
  };
  const anchor = typeof value.cadenceSetAt === 'string' ? value.cadenceSetAt : String(value.createdAt);
  return { id: String(value.id), kind: value.kind as EntityKind, name: String(value.name), description: textOrNull(value.description), refs: (value.refs as string[]).slice().sort(), card: { ...card, nextDueAt: nextDue(card, anchor) } };
}

async function entity(tx: Runner, ownerKey: string, id: string): Promise<Entity> {
  const result = await tx.run(`MATCH (e:OverlayEntity {id: $id, ownerKey: $ownerKey}) RETURN ${ENTITY} AS entity`, { id, ownerKey });
  const found = result.records[0]?.get('entity') as Record<string, unknown> | undefined;
  // Missing and someone else's are the same answer.
  return found ? entityFrom(found) : fail(404, 'not_found');
}

async function detail(tx: Runner, ownerKey: string, id: string): Promise<EntityDetail> {
  const base = await entity(tx, ownerKey, id);
  const notes = await tx.run(`MATCH (n:OverlayNote {ownerKey: $ownerKey, entityId: $id})
    RETURN ${NOTE} AS note ORDER BY n.createdAt DESC LIMIT $limit`, { ownerKey, id, limit: neo4j.int(LIMITS.notesPerEntity) });
  const links = await tx.run(`MATCH (e:OverlayEntity {id: $id, ownerKey: $ownerKey})-[l:OVERLAY_LINK]-(other:OverlayEntity {ownerKey: $ownerKey})
    RETURN ${EDGE} AS edge, CASE WHEN startNode(l) = e THEN 'out' ELSE 'in' END AS direction, ${end('other')} AS other
    ORDER BY l.createdAt DESC LIMIT 500`, { ownerKey, id });
  return {
    ...base,
    notes: notes.records.map(record => noteFrom(record.get('note') as Record<string, unknown>)),
    links: links.records.map(record => linkFrom(edgeFrom(record.get('edge') as Record<string, unknown>), record.get('direction') as 'out' | 'in', endFrom(record.get('other') as Record<string, unknown>))),
  };
}

async function limit(tx: Runner, query: string, ownerKey: string, max: number, code: string): Promise<void> {
  const count = await tx.run(query, { ownerKey });
  if (number(count.records[0]?.get('total')) >= max) fail(409, code);
}

async function writeCard(tx: Runner, ownerKey: string, id: string, current: Card, patch: CardPatch, now: string): Promise<void> {
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
