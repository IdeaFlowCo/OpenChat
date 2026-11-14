import { CONTACT_SOURCE_CONSTRAINT, actorProvenance, contactInput, sourcesIn, stateFrom, stateInput, stateCard, stableJSON, peopleOperationFingerprint, replayPeopleOperation } from './contacts.js';
import { BLURB_CONSTRAINTS, mutateBlurbIn, loadBlurbs, changesIn, shelf, pageLimit, digest, blurbFeedIn } from './blurbs.js';
import { eraseAskPublicationIn, revokeAskPublicationIn } from './publications.js';
import { FIELD_CONSTRAINTS, FIELD_LABELS, markFieldIn, parseMarkFieldInput, parseSetFieldInput, projectFields, fieldSuggestions, setFieldIn, sourceAssertions, storedAssertionsIn } from './fields.js';
import type { FieldContext, PersonField } from './fields.js';
import { MERGE_CONSTRAINTS, MERGE_LABELS, headOf, membersOf, memberSummaries, mergeIn, splitIn, revertIn, listMergeEventsIn, exportMergesIn, parseMergeInput, parseSplitInput, parseRevertInput } from './merge.js';
import { createHash } from 'node:crypto';
import neo4j from 'neo4j-driver';
import type { Driver, ManagedTransaction } from 'neo4j-driver';
import { nanoid } from 'nanoid';
import {
  ASK_EXPOSURES, ASK_HORIZONS, ASK_STATUSES, ASKER_KINDS, CARRIER_KINDS, placementKey, askKeyOf, askName, askRecheckAfter, cleanDescription, cleanKind, cleanLinkAttributes, cleanName, cleanNamedKind, cleanProvenance, cleanRef,
  cleanRelation, cleanRelationType, cleanRequestId, cleanText, EMPTY_CARD, fail, intervalAfterContact, isId, isOwnerKey, isSeparateRef, LIMITS, nameKey, nextDue, OverlayError,
  parseAskFilter, parseAskInput, parseAskPatch, parseLinkPatch, readProvenance, readRelationType, relationTypeOf, separateRef,
} from './contract.js';
import type {
  Ask, AskSourceReceipt, AskEvidence, AskExposure, AskFields, AskFilter, AskHorizon, AskInput, AskPartyRef, AskPatch, AskPlacement, AskPlacementRef, AskStatus, Candidate, Card, CardPatch, DueEntity, Edge, Entity, EntityDetail, EntityKind, Link,
  LinkAttributeInput, LinkEnd, LinkPatch, NamedKind, Neighbourhood, Note, OverlayPrincipal, Provenance, RelationType, SearchHit, SearchResult,
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
      for (const statement of [CONTACT_SOURCE_CONSTRAINT,
        ...BLURB_CONSTRAINTS, ...MERGE_CONSTRAINTS, ...FIELD_CONSTRAINTS,
        'CREATE CONSTRAINT overlay_note_revision_id IF NOT EXISTS FOR (r:OverlayNoteRevision) REQUIRE r.id IS UNIQUE',
        'CREATE INDEX overlay_note_revision_note IF NOT EXISTS FOR (r:OverlayNoteRevision) ON (r.ownerKey, r.noteId)',
        'CREATE CONSTRAINT overlay_entity_id IF NOT EXISTS FOR (e:OverlayEntity) REQUIRE e.id IS UNIQUE',
        // Entities made by name (no ref) are one per owner, kind and name; ref-bound entities leave nameSlot null.
        'CREATE CONSTRAINT overlay_entity_name IF NOT EXISTS FOR (e:OverlayEntity) REQUIRE (e.ownerKey, e.nameSlot) IS UNIQUE',
        'CREATE CONSTRAINT overlay_ref_key IF NOT EXISTS FOR (r:OverlayRef) REQUIRE (r.ownerKey, r.ref) IS UNIQUE',
        'CREATE CONSTRAINT overlay_note_id IF NOT EXISTS FOR (n:OverlayNote) REQUIRE n.id IS UNIQUE',
        'CREATE CONSTRAINT overlay_link_key IF NOT EXISTS FOR ()-[l:OVERLAY_LINK]-() REQUIRE l.linkKey IS UNIQUE',
        // One ask per owner, author and text; entities that are not asks leave askKey null.
        'CREATE CONSTRAINT overlay_ask_publication_id IF NOT EXISTS FOR (p:OverlayAskPublication) REQUIRE p.id IS UNIQUE',
        'CREATE CONSTRAINT overlay_ask_publication_ask IF NOT EXISTS FOR (p:OverlayAskPublication) REQUIRE (p.ownerKey,p.askId) IS UNIQUE',
        'CREATE CONSTRAINT overlay_ask_publication_operation IF NOT EXISTS FOR (o:OverlayAskPublicationOperation) REQUIRE (o.ownerKey,o.requestId) IS UNIQUE',
        'CREATE CONSTRAINT overlay_ask_source IF NOT EXISTS FOR (s:OverlayAskSource) REQUIRE (s.ownerKey, s.sourceKey) IS UNIQUE',
        'CREATE CONSTRAINT overlay_ask_key IF NOT EXISTS FOR (e:OverlayEntity) REQUIRE (e.ownerKey, e.askKey) IS UNIQUE',
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

  async mutateBlurb(principal: OverlayPrincipal | null, input: unknown) {
    const ownerKey = this.owner(principal);
    return this.write(tx => mutateBlurbIn(tx, ownerKey, input));
  }
  async readBlurbs(principal: OverlayPrincipal | null, mode: string, input: Record<string, unknown> = {}) {
    const ownerKey = this.owner(principal);
    const work = async (tx: ManagedTransaction) => {
      if (mode === 'snapshot') await tx.run('MERGE (c:OverlayBlurbClock {ownerKey:$ownerKey}) ON CREATE SET c.sequence=0 SET c._lock=true REMOVE c._lock', {ownerKey});
      if (mode === 'feed') return blurbFeedIn(tx, ownerKey, input.cursor, input.limit);
      if (mode === 'changes') return changesIn(tx, ownerKey, input.cursor, input.limit);
      const state = await loadBlurbs(tx, ownerKey);
      if (mode === 'snapshot') {
        const r = await tx.run('MATCH (c:OverlayBlurbClock {ownerKey:$ownerKey}) RETURN c.sequence AS sequence', {ownerKey});
        return {...state, cursor: String(r.records[0]?.get('sequence') ?? 0)};
      }
      if (mode === 'get') {
        const blurb = state.blurbs.find(b => b.id === input.id);
        if (!blurb) return fail(404, 'not_found');
        return { blurb, revision: digest(blurb) };
      }
      const limit = pageLimit(input.limit);
      const after = input.after === undefined ? '' : String(input.after);
      if (after.length > 200) return fail(400, 'invalid_cursor');
      const rows = mode === 'candidates' ? state.candidates : mode === 'conflicts' ? state.conflicts : shelf(state, typeof input.q === 'string' ? input.q : '');
      const ordered = rows.map((row: any) => ({...row, pageKey: row.variantId ? (nameKey(row.shortcut ?? '') === nameKey(String(input.q ?? '')) || nameKey(row.title) === nameKey(String(input.q ?? '')) ? '0' : '1') + (row.pinned ? '0' : '1') + ':' + row.id + ':' + row.variantId : row.id})).sort((a,b) => a.pageKey < b.pageKey ? -1 : a.pageKey > b.pageKey ? 1 : 0).filter(x => x.pageKey > after);
      const items = ordered.slice(0,limit);
      return { items, nextCursor: ordered.length > limit ? items.at(-1)!.pageKey : null };
    };
    return mode === 'snapshot' ? this.write(work) : this.read(work);
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
    const ownerKey = this.owner(principal), kind = cleanNamedKind(input?.kind), name = cleanName(input?.name), description = cleanDescription(input?.description);
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
    const ownerKey = this.owner(principal), kind = cleanNamedKind(input?.kind), name = cleanName(input?.name), description = cleanDescription(input?.description);
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
  async update(principal: OverlayPrincipal | null, id: unknown, patch: { name?: unknown; addRef?: unknown; card?: CardPatch; description?: unknown; kind?: unknown }, provenance?: unknown): Promise<Entity> {
    const ownerKey = this.owner(principal);
    if (!isId(id)) return fail(404, 'not_found');
    const name = patch.name === undefined ? undefined : cleanName(patch.name);
    const addRef = patch.addRef === undefined ? undefined : cleanRef(patch.addRef);
    const description = patch.description === undefined ? undefined : cleanDescription(patch.description);
    const kind = patch.kind === undefined ? undefined : cleanNamedKind(patch.kind);
    const by = patch.card ? actorProvenance(principal!, provenance) : undefined;
    if (name === undefined && addRef === undefined && !patch.card && description === undefined && kind === undefined) return fail(400, 'nothing_to_change');
    const requested = id;
    return this.write(async tx => {
      await lockBlurbClock(tx, ownerKey);
      // A merged-away record's edits are its person's.
      const id: string = await headOf(tx, ownerKey, requested) ?? fail(404, 'not_found');
      if (patch.card) await tx.run('MATCH (e:OverlayEntity {ownerKey:$ownerKey,id:$id}) SET e._lock=true REMOVE e._lock', {ownerKey,id});
      const current = await entity(tx, ownerKey, id), now = new Date().toISOString();
      // An ask's name follows its text and it has no refs: edit it with updateAsk.
      if (current.kind === 'blurb') fail(409, 'use_blurb_operations');
      if (current.kind === 'ask' && (name !== undefined || kind !== undefined || addRef !== undefined || patch.card)) fail(409, 'ask_fields');
      // A party to asks keeps a kind that can play its part: an author or placement stays a kind that can ask, a carrier one that can act.
      if (kind !== undefined && kind !== current.kind) {
        if (requested !== id) fail(409, 'merged_record');
        if ((await membersOf(tx, ownerKey, [id])).get(id)!.length > 1) fail(409, 'merged_person');
        const parts = await tx.run(`MATCH (a:OverlayEntity {ownerKey: $ownerKey, kind: 'ask'})
          WHERE coalesce(a.askAuthorId, a.askerId) = $id OR a.carrierId = $id OR ('entity:' + $id) IN coalesce(a.placements, [])
          RETURN sum(CASE WHEN coalesce(a.askAuthorId, a.askerId) = $id OR ('entity:' + $id) IN coalesce(a.placements, []) THEN 1 ELSE 0 END) AS cares, sum(CASE WHEN a.carrierId = $id THEN 1 ELSE 0 END) AS carries`, { ownerKey, id });
        const row = parts.records[0];
        if ((number(row?.get('cares')) && !ASKER_KINDS.includes(kind)) || (number(row?.get('carries')) && !CARRIER_KINDS.includes(kind))) fail(409, 'has_asks');
      }
      const nextName = name ?? current.name, nextKind = kind ?? current.kind;
      if (nextKind !== current.kind && !current.refs.every(isSeparateRef)) fail(409, 'kind_fixed');
      if (nextName !== current.name || nextKind !== current.kind) {
        await renameEntityIn(tx, ownerKey, id, nextName, nextKind, now);
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
      if (patch.card) {
        const explicitNextDueAt = await writeCard(tx, ownerKey, id, current.card, patch.card, now);
        const updated = await entity(tx, ownerKey, id);
        const previous = current.peopleState;
        const state = {schemaVersion:1, revision:(previous?.revision ?? 0)+1,
          payload:{...(previous?.payload ?? {schemaVersion:1}), card:{...(previous?.payload.card && typeof previous.payload.card === 'object' && !Array.isArray(previous.payload.card) ? previous.payload.card : {}), ...updated.card, nextDueAt:explicitNextDueAt}}, updatedAt:now, ...by};
        await tx.run('MATCH (e:OverlayEntity {ownerKey:$ownerKey,id:$id}) SET e.peopleState=$state', {ownerKey,id,state:JSON.stringify(state)});
      }
      return entity(tx, ownerKey, id);
    });
  }

  /** The same text already on this entity is the same note: a retried write never doubles it. */
  async addNote(principal: OverlayPrincipal | null, entityId: unknown, rawText: unknown, provenance?: unknown): Promise<{ note: Note; created: boolean }> {
    const ownerKey = this.owner(principal), text = cleanText(rawText, LIMITS.noteLength, 'invalid_note'), by = cleanProvenance(provenance);
    if (!isId(entityId)) return fail(404, 'not_found');
    return this.write(tx => addNoteIn(tx, ownerKey, entityId, text, by));
  }

  /**
   * Edits a note in place: same id, createdAt and ask evidence. The text it
   * replaces is kept as an immutable revision (`listNoteRevisions`). With
   * `ifRevision`, an edit based on an older revision is refused with 409
   * `stale_revision` and the current note, so the caller can offer both.
   * Saving the same text again changes nothing.
   */
  async updateNote(principal: OverlayPrincipal | null, noteId: unknown, rawText: unknown, options: { ifRevision?: unknown; provenance?: unknown } = {}): Promise<Note> {
    const ownerKey = this.owner(principal), text = cleanText(rawText, LIMITS.noteLength, 'invalid_note'), by = cleanProvenance(options.provenance);
    if (!isId(noteId)) return fail(404, 'not_found');
    const ifRevision = options.ifRevision === undefined || options.ifRevision === null ? null
      : Number.isSafeInteger(options.ifRevision) && (options.ifRevision as number) >= 1 ? options.ifRevision as number : fail(400, 'invalid_revision');
    return this.write(tx => updateNoteIn(tx, ownerKey, noteId, text, ifRevision, by));
  }

  /** A note's earlier texts, newest first, with the current one. Restoring one is an edit with that text. */
  async listNoteRevisions(principal: OverlayPrincipal | null, noteId: unknown): Promise<{ note: Note; revisions: NoteRevision[] }> {
    const ownerKey = this.owner(principal);
    if (!isId(noteId)) return fail(404, 'not_found');
    return this.read(async tx => {
      const found = await tx.run(`MATCH (n:OverlayNote {id: $noteId, ownerKey: $ownerKey}) RETURN ${NOTE} AS note`, { noteId, ownerKey });
      const note = found.records[0]?.get('note') as Record<string, unknown> | undefined;
      if (!note) return fail(404, 'not_found');
      const rows = await tx.run('MATCH (r:OverlayNoteRevision {ownerKey: $ownerKey, noteId: $noteId}) RETURN r { .revision, .text, .author, .savedAt, .replacedAt, .replacedBy } AS r ORDER BY r.revision DESC', { noteId, ownerKey });
      return { note: noteFrom(note), revisions: rows.records.map(row => { const r = row.get('r') as Record<string, unknown>;
        return { revision: Number(r.revision), text: String(r.text), author: (r.author as string) ?? null, savedAt: String(r.savedAt), replacedAt: String(r.replacedAt), replacedBy: (r.replacedBy as string) ?? null }; }) };
    });
  }

  /** The person's fields with history and the suggestions found in their notes (Wi-Fi passwords masked). */
  async personFields(principal: OverlayPrincipal | null, id: unknown): Promise<{ id: string; fields: PersonField[]; fieldSuggestions: ReturnType<typeof fieldSuggestions> }> {
    const ownerKey = this.owner(principal);
    if (!isId(id)) return fail(404, 'not_found');
    return this.read(async tx => {
      const ctx = await fieldContext(tx, ownerKey, id);
      const { fields, suggestions } = await fieldsIn(tx, ownerKey, ctx);
      return { id: ctx.headId, fields, fieldSuggestions: suggestions };
    });
  }

  /** Records one value about a person (an assertion; never overwrites). `supersedes` makes the value it replaces former. */
  async setPersonField(principal: OverlayPrincipal | null, id: unknown, input: unknown, provenance?: unknown) {
    const ownerKey = this.owner(principal), by = { ...cleanProvenance(provenance), ...(principal?.actorId ? { actorId: principal.actorId } : {}) };
    if (!isId(id)) return fail(404, 'not_found');
    const parsed = parseSetFieldInput(input, by.author === 'owner' ? 'owner' : by.author ?? 'owner');
    return this.write(async tx => {
      await lockBlurbClock(tx, ownerKey);
      const ctx = await fieldContext(tx, ownerKey, id);
      const result = await setFieldIn(tx, ownerKey, ctx, parsed, by);
      const { fields, suggestions } = await fieldsIn(tx, ownerKey, ctx);
      return { ...result, id: ctx.headId, fields, fieldSuggestions: suggestions };
    });
  }

  /** Former, wrong, hidden, pin, unpin or restore a value (by key); retract an assertion; dismiss a suggestion; undo an operation. */
  async markPersonField(principal: OverlayPrincipal | null, id: unknown, input: unknown, provenance?: unknown) {
    const ownerKey = this.owner(principal), by = cleanProvenance(provenance);
    if (!isId(id)) return fail(404, 'not_found');
    const parsed = parseMarkFieldInput(input);
    return this.write(async tx => {
      await lockBlurbClock(tx, ownerKey);
      const ctx = await fieldContext(tx, ownerKey, id);
      const result = await markFieldIn(tx, ownerKey, ctx, parsed, by);
      const { fields, suggestions } = await fieldsIn(tx, ownerKey, ctx);
      return { ...result, id: ctx.headId, fields, fieldSuggestions: suggestions };
    });
  }

  /** The explicit read of one value, unmasked (a Wi-Fi password). Lists, searches and person reads never include it. */
  async revealPersonField(principal: OverlayPrincipal | null, id: unknown, key: unknown) {
    const ownerKey = this.owner(principal);
    if (!isId(id) || typeof key !== 'string') return fail(404, 'not_found');
    return this.read(async tx => {
      const ctx = await fieldContext(tx, ownerKey, id);
      const { fields, suggestions } = await fieldsIn(tx, ownerKey, ctx, true);
      const field = fields.find(f => f.key === key);
      if (field) return { key, kind: field.kind, label: field.label, value: field.value };
      const suggestion = suggestions.find(s => s.id === key);
      if (suggestion) return { key, kind: suggestion.kind, label: suggestion.label, value: suggestion.value };
      return fail(404, 'field_not_found');
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
  async deleteEntity(principal: OverlayPrincipal | null, id: unknown): Promise<{ notesRemoved: number; linksRemoved: number; refsRemoved: number; asksRemoved: number }> {
    const ownerKey = this.owner(principal);
    if (!isId(id)) return fail(404, 'not_found');
    return this.write(tx => deleteEntityIn(tx, ownerKey, id));
  }

  async list(principal: OverlayPrincipal | null, filter: { q?: unknown; kind?: unknown } = {}): Promise<Entity[]> {
    const ownerKey = this.owner(principal);
    const q = typeof filter.q === 'string' ? nameKey(filter.q).slice(0, LIMITS.nameLength) : '';
    const kind = filter.kind === undefined || filter.kind === null || filter.kind === '' ? null : cleanKind(filter.kind);
    return this.read(async tx => {
      // A merged record's name finds its person.
      const result = await tx.run(`MATCH (x:OverlayEntity {ownerKey: $ownerKey})
        WHERE x.kind <> 'blurb' AND (CASE WHEN $kind IS NULL THEN x.kind <> 'ask' ELSE x.kind = $kind END) AND ($q = '' OR x.nameKey CONTAINS $q)
        WITH DISTINCT coalesce(x.mergedInto, x.id) AS head
        MATCH (e:OverlayEntity {ownerKey: $ownerKey, id: head})
        RETURN ${ENTITY} AS entity ORDER BY e.nameKey LIMIT 50`, { ownerKey, q, kind });
      return result.records.map(record => entityFrom(record.get('entity') as Record<string, unknown>));
    });
  }

  /** Keyset pages over immutable IDs. Reads never create entities or relationships.
   * Cursors are scoped to the owner and filter by the route's caller; a changed
   * graph can add/remove results, so consumers reconcile against import receipts.
   */
  async listPage(principal: OverlayPrincipal | null, filter: { kind?: unknown; q?: unknown; excludeRefPrefix?: unknown; after?: unknown; limit?: unknown; details?: boolean; namedOnly?: boolean } = {}): Promise<{ entities: Entity[]; nextCursor: string | null; total: number }> {
    const ownerKey = this.owner(principal);
    const kind = filter.kind === undefined ? null : cleanKind(filter.kind);
    const q = typeof filter.q === 'string' ? nameKey(filter.q).slice(0, LIMITS.nameLength) : '';
    const exclude = filter.excludeRefPrefix === 'openchat:user:' ? 'openchat:user:' : '';
    const namedOnly = filter.namedOnly === true;
    const scope = pageScope([ownerKey, 'entities', kind, q, exclude, namedOnly]);
    const { after, limit } = pageInput(filter, scope);
    return this.read(async tx => {
      // One row per person: merged-away records are read through their head, and a name filter also matches their names.
      const where = `e.kind <> 'blurb' AND e.mergedInto IS NULL AND (NOT $namedOnly OR e.kind <> 'ask') AND ($kind IS NULL OR e.kind = $kind)
        AND ($q = '' OR e.nameKey CONTAINS $q OR EXISTS { MATCH (m:OverlayEntity {ownerKey:$ownerKey, mergedInto:e.id}) WHERE m.nameKey CONTAINS $q })
        AND ($exclude = '' OR NOT EXISTS { MATCH (r:OverlayRef {ownerKey:$ownerKey})-[:REF_OF]->(e) WHERE r.ref STARTS WITH $exclude })`;
      const args = { ownerKey, kind, q, exclude, namedOnly, after, limit: neo4j.int(limit + 1) };
      const result = await tx.run(`MATCH (e:OverlayEntity {ownerKey:$ownerKey}) WHERE ${where} AND e.id > $after
        RETURN ${ENTITY} AS entity ORDER BY e.id LIMIT $limit`, args);
      const total = await tx.run(`MATCH (e:OverlayEntity {ownerKey:$ownerKey}) WHERE ${where} RETURN count(e) AS total`, args);
      const entities = result.records.slice(0, limit).map(record => entityFrom(record.get('entity') as Record<string, unknown>));
      const summaries = await memberSummaries(tx, ownerKey, entities.map(e => e.id));
      for (const e of entities) { const members = summaries.get(e.id); if (members) e.members = members; }
      if (filter.details) {
        // A person's details are its head's plus its merged records'.
        const clusters = await membersOf(tx, ownerKey, entities.map(e => e.id));
        const headOfId = new Map([...clusters].flatMap(([head, ids]) => ids.map(id => [id, head] as const)));
        const ids = [...headOfId.keys()], sources = await sourcesIn(tx, ownerKey, ids);
        // Fetch the page's notes/links in batches, not serial per-person HTTP calls.
        const notes = await tx.run(`MATCH (n:OverlayNote {ownerKey:$ownerKey}) WHERE n.entityId IN $ids RETURN n.entityId AS id, ${NOTE} AS note ORDER BY n.createdAt DESC`, {ownerKey, ids});
        const links = await tx.run(`MATCH (e:OverlayEntity {ownerKey:$ownerKey})-[l:OVERLAY_LINK]-(other:OverlayEntity {ownerKey:$ownerKey})
          WHERE e.id IN $ids AND l.ownerKey=$ownerKey AND (other.kind <> 'blurb' OR other.deletedAt IS NULL)
          OPTIONAL MATCH (otherHead:OverlayEntity {ownerKey:$ownerKey, id:other.mergedInto})
          WITH e, l, coalesce(otherHead, other) AS shown
          RETURN e.id AS id, ${EDGE} AS edge, CASE WHEN startNode(l)=e THEN 'out' ELSE 'in' END AS direction, ${end('shown')} AS other ORDER BY l.createdAt DESC, l.id DESC`, {ownerKey, ids});
        const byID = new Map(entities.map(e => [e.id, Object.assign(e, {notes: [] as Note[], links: [] as Link[], contactSources: [] as Array<Record<string, unknown>>})]));
        for (const [id, head] of headOfId) for (const source of sources.get(id) ?? []) byID.get(head)?.contactSources.push(clusters.get(head)!.length > 1 ? { ...source, memberId: id } : source as unknown as Record<string, unknown>);
        for (const row of notes.records) byID.get(headOfId.get(String(row.get('id')))!)?.notes.push(noteFrom(row.get('note') as Record<string, unknown>));
        const seen = new Set<string>();
        for (const row of links.records) {
          const head = headOfId.get(String(row.get('id')))!, link = linkFrom(edgeFrom(row.get('edge') as Record<string, unknown>), row.get('direction') as 'out'|'in', endFrom(row.get('other') as Record<string, unknown>));
          if (link.other.id === head) continue;
          const key = JSON.stringify([head, link.direction, link.relation, link.other.id]);
          if (seen.has(key)) continue;
          seen.add(key); byID.get(head)?.links.push(link);
        }
      }
      return { entities, total: number(total.records[0]?.get('total')), nextCursor: result.records.length > limit ? pageCursor(scope, entities[entities.length - 1]!.id) : null };
    });
  }

  async importContact(principal: OverlayPrincipal | null, raw: unknown, provenance?: unknown) {
    const ownerKey = this.owner(principal), input = contactInput(raw), by = actorProvenance(principal!, provenance);
    return retryOnce(() => this.write(async tx => {
      await lockBlurbClock(tx, ownerKey);
      // The unique source node serializes retry/concurrent uploads before creating an entity.
      const locked = await tx.run(`MERGE (s:OverlayContactSource {ownerKey:$ownerKey, sourceKey:$sourceKey}) SET s._lock=true REMOVE s._lock RETURN s.entityId AS id, s.data AS data, s.name AS name`, {ownerKey, sourceKey:input.sourceKey});
      const existing = locked.records[0]?.get('id') as string | null;
      // An explicit entity is compared and attached as a person: a merged-away id means its head.
      const requested = input.entityId ? await headOf(tx, ownerKey, input.entityId) ?? input.entityId : undefined;
      if (existing && requested && (await headOf(tx, ownerKey, existing) ?? existing) !== requested) return fail(409, 'contact_identity_conflict');
      let id = existing ?? requested, created = false;
      if (id) {
        const target = await tx.run('MATCH (e:OverlayEntity {ownerKey:$ownerKey,id:$id}) SET e._lock=true REMOVE e._lock RETURN e.id AS id', {ownerKey,id});
        if (!target.records.length) return fail(404,'not_found');
        await entity(tx, ownerKey, id);
      }
      else {
        const result = await ensureIn(tx, ownerKey, {kind:'person', name:input.name, ref:`contacts:source:${input.sourceKey}`});
        id = result.entity.id; created = result.created;
      }
      const data = stableJSON(input.data), unchanged = existing !== null && locked.records[0]?.get('data') === data && locked.records[0]?.get('name') === input.name;
      if (!unchanged) await tx.run(`MATCH (s:OverlayContactSource {ownerKey:$ownerKey, sourceKey:$sourceKey})
        SET s.entityId=$id, s.source=$source, s.sourceId=$sourceId, s.name=$name, s.data=$data, s.updatedAt=$now, s.author=$author, s.sourceVia=$via, s.assertion=$assertion, s.actorId=$actorId`,
        {ownerKey, sourceKey:input.sourceKey, id, source:input.source, sourceId:input.sourceId, name:input.name, data, now:new Date().toISOString(), author:by.author, via:by.source, assertion:by.assertion, actorId:by.actorId});
      return {entity:await entity(tx, ownerKey, await headOf(tx, ownerKey, id) ?? id), created, unchanged};
    }));
  }

  async importContacts(principal:OverlayPrincipal|null, raw:unknown, provenance?:unknown) {
    this.owner(principal);
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 25) return fail(400,'invalid_contact_batch');
    const results: Array<Record<string,unknown>>=[];
    for (let index=0;index<raw.length;index++) {
      try {const result=await this.importContact(principal,raw[index],provenance);results.push({index,id:result.entity.id,created:result.created,unchanged:result.unchanged});}
      catch(error) {results.push({index,error:error instanceof OverlayError && error.status<500 ? error.code : 'contact_import_unavailable'});}
    }
    return {results};
  }

  async savePeopleState(principal: OverlayPrincipal | null, id: unknown, raw: unknown, provenance?: unknown) {
    const ownerKey = this.owner(principal), input = stateInput(raw, provenance), card = stateCard(input.payload.card), by = actorProvenance(principal!, input.provenance);
    if (!isId(id)) return fail(404, 'not_found');
    const requested = id;
    return this.write(async tx => {
      await lockBlurbClock(tx, ownerKey);
      // People state belongs to the person: a merged-away record's id writes its head's state.
      id = await headOf(tx, ownerKey, requested) ?? fail(404, 'not_found');
      const found = await tx.run('MATCH (e:OverlayEntity {ownerKey:$ownerKey, id:$id}) SET e._lock=true REMOVE e._lock RETURN e.peopleState AS state', {ownerKey,id});
      if (!found.records.length) return fail(404,'not_found');
      const previous = stateFrom(found.records[0]!.get('state'));
      // The receipt binds the id the client sent, so a retry after a merge still replays.
      const request = {id:requested, expectedRevision:input.expectedRevision, payload:input.payload, app:principal!.app};
      const fingerprint = peopleOperationFingerprint(request, by);
      const receipt = await tx.run(`MATCH (r:OverlayPeopleOperation {ownerKey:$ownerKey,operationId:$operationId})
        WHERE coalesce(r.requestedId, r.entityId) = $requested OR (r.requestedId IS NULL AND (r.entityId IN $ids OR r.fingerprint = $fingerprint))
        RETURN elementId(r) AS receiptId,r.fingerprint AS fingerprint,r.fingerprintVersion AS fingerprintVersion,r.state AS state
        ORDER BY coalesce(r.requestedId, r.entityId) = $requested DESC LIMIT 1`, {ownerKey,ids:[...new Set([id, requested])],requested,operationId:input.operationId,fingerprint});
      if (receipt.records.length) {
        const row = receipt.records[0]!;
        const replay = replayPeopleOperation(request, by, {fingerprint:row.get('fingerprint'), fingerprintVersion:row.get('fingerprintVersion') === null ? null : number(row.get('fingerprintVersion')), state:row.get('state')});
        await tx.run('MATCH (r:OverlayPeopleOperation {ownerKey:$ownerKey}) WHERE elementId(r)=$receiptId SET r.requestedId=$requested, r.fingerprint=$fingerprint,r.fingerprintVersion=2', {ownerKey,receiptId:row.get('receiptId'),requested,fingerprint});
        return replay.state;
      }
      if ((previous?.revision ?? 0) !== input.expectedRevision) return fail(409,'state_conflict');
      const state = {schemaVersion:1 as const, revision:input.expectedRevision+1, payload:input.payload, updatedAt:new Date().toISOString(), ...by};
      await tx.run('MATCH (e:OverlayEntity {ownerKey:$ownerKey,id:$id}) SET e.peopleState=$state', {ownerKey,id,state:JSON.stringify(state)});
      if (card) await tx.run(`MATCH (e:OverlayEntity {ownerKey:$ownerKey,id:$id})
        WITH e, coalesce(e.cadenceDays, 0) <> coalesce($card.cadenceDays, 0)
          OR coalesce(e.cadenceMode, 'fixed') <> $card.cadenceMode AS cadenceChanged
        SET e += $card, e.cadenceSetAt = CASE WHEN cadenceChanged THEN $now ELSE e.cadenceSetAt END`, {ownerKey,id,card,now:state.updatedAt});
      await tx.run('CREATE (:OverlayPeopleOperation {ownerKey:$ownerKey,entityId:$id,requestedId:$requested,operationId:$operationId,fingerprint:$fingerprint,fingerprintVersion:2,state:$state})', {ownerKey,id,requested,operationId:input.operationId,fingerprint,state:JSON.stringify(state)});
      return state;
    });
  }

  async linksPage(principal: OverlayPrincipal | null, id: unknown, filter: { after?: unknown; limit?: unknown } = {}): Promise<{ links: Link[]; nextCursor: string | null }> {
    const ownerKey = this.owner(principal);
    if (!isId(id)) return fail(404, 'not_found');
    const scope = pageScope([ownerKey, 'links', id]);
    const { after, limit } = pageInput(filter, scope);
    return this.read(async tx => {
      await entity(tx, ownerKey, id);
      // Through every record of the person; links between its own records are not shown.
      const head = (await headOf(tx, ownerKey, id))!, ids = (await membersOf(tx, ownerKey, [head])).get(head)!;
      const result = await tx.run(`MATCH (e:OverlayEntity {ownerKey: $ownerKey})-[l:OVERLAY_LINK]-(other:OverlayEntity {ownerKey: $ownerKey})
        WHERE e.id IN $ids AND l.ownerKey = $ownerKey AND (e.kind <> 'blurb' OR e.deletedAt IS NULL) AND (other.kind <> 'blurb' OR other.deletedAt IS NULL)
        OPTIONAL MATCH (otherHead:OverlayEntity {ownerKey: $ownerKey, id: other.mergedInto})
        WITH e, l, coalesce(otherHead, other) AS shown WHERE NOT shown.id IN $ids
        WITH shown, l, CASE WHEN startNode(l) = e THEN 'out' ELSE 'in' END AS direction ORDER BY l.createdAt DESC, l.id DESC
        WITH shown, direction, l.relation AS relation, collect(l)[0] AS l WHERE l.id > $after
        RETURN ${EDGE} AS edge, direction, ${end('shown')} AS other
        ORDER BY l.id LIMIT $limit`, { ownerKey, ids, after, limit: neo4j.int(limit + 1) });
      const links = result.records.slice(0, limit).map(record => linkFrom(edgeFrom(record.get('edge') as Record<string, unknown>), record.get('direction') as 'out' | 'in', endFrom(record.get('other') as Record<string, unknown>)));
      return { links, nextCursor: result.records.length > limit ? pageCursor(scope, links[links.length - 1]!.id) : null };
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
        // A hit on a merged record is a hit on its person (one row, its reasons combined).
        const found = await tx.run(`MATCH (x:OverlayEntity {ownerKey: $ownerKey})
          WHERE x.kind <> 'blurb' AND ($kind IS NULL OR x.kind = $kind)
          WITH x, ($q = '' OR x.nameKey CONTAINS $q OR toLower(coalesce(x.askText, '')) CONTAINS $q) AS byName,
            ($q <> '' AND toLower(coalesce(x.description, '')) CONTAINS $q) AS byDescription,
            ($q <> '' AND EXISTS { MATCH (n:OverlayNote {ownerKey: $ownerKey, entityId: x.id}) WHERE toLower(n.text) CONTAINS $q }) AS byNote
          WHERE byName OR byDescription OR byNote
          WITH coalesce(x.mergedInto, x.id) AS head, max(CASE WHEN byName THEN 1 ELSE 0 END) = 1 AS byName,
            max(CASE WHEN byDescription THEN 1 ELSE 0 END) = 1 AS byDescription, max(CASE WHEN byNote THEN 1 ELSE 0 END) = 1 AS byNote
          MATCH (e:OverlayEntity {ownerKey: $ownerKey, id: head})
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
        // Ends read as their people; a link between two records of one person is not a relation.
        const rows = await tx.run(`MATCH (a0:OverlayEntity {ownerKey: $ownerKey})-[l:OVERLAY_LINK]->(b0:OverlayEntity {ownerKey: $ownerKey})
          WHERE l.ownerKey = $ownerKey AND (a0.kind <> 'blurb' OR a0.deletedAt IS NULL) AND (b0.kind <> 'blurb' OR b0.deletedAt IS NULL) AND ($kind IS NULL OR a0.kind = $kind OR b0.kind = $kind)
          OPTIONAL MATCH (ah:OverlayEntity {ownerKey: $ownerKey, id: a0.mergedInto})
          OPTIONAL MATCH (bh:OverlayEntity {ownerKey: $ownerKey, id: b0.mergedInto})
          WITH l, coalesce(ah, a0) AS a, coalesce(bh, b0) AS b WHERE a <> b
          RETURN ${EDGE} AS edge, ${end('a')} AS fromEnd, ${end('b')} AS toEnd,
            COLLECT { MATCH (m:OverlayEntity {ownerKey:$ownerKey}) WHERE m.mergedInto IN [a.id, b.id] RETURN m.name AS name } AS memberNames
          ORDER BY l.createdAt DESC, l.id DESC`,
        { ownerKey, kind });
        const seen = new Set<string>();
        for (const record of rows.records) {
          const edge = edgeFrom(record.get('edge') as Record<string, unknown>);
          const from = endFrom(record.get('fromEnd') as Record<string, unknown>), to = endFrom(record.get('toEnd') as Record<string, unknown>);
          if (relationType && edge.relationType !== relationType) continue;
          if (q && ![edge.relation, from.name, to.name, edge.context ?? '', ...((record.get('memberNames') as string[]) ?? [])].some(value => nameKey(value).includes(q))) continue;
          const key = JSON.stringify([from.id, edge.relation, to.id]);
          if (seen.has(key)) continue;
          seen.add(key);
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
      // People, not records: the center and every end are heads, and each hop reads through all of a person's records.
      const centerId = await headOf(tx, ownerKey, id);
      if (centerId === null) return fail(404, 'not_found');
      const center = await entity(tx, ownerKey, centerId);
      const entities = new Map<string, Entity>(), links = new Map<string, Edge>();
      let truncated = false, frontier = [center.id];
      const seen = new Set([center.id]);
      for (let hop = 1; hop <= depth && frontier.length; hop++) {
        const records = [...new Set([...(await membersOf(tx, ownerKey, frontier)).values()].flat())];
        const rows = await tx.run(`MATCH (a0:OverlayEntity {ownerKey:$ownerKey})-[l:OVERLAY_LINK]->(b0:OverlayEntity {ownerKey:$ownerKey})
          WHERE (a0.id IN $ids OR b0.id IN $ids) AND l.ownerKey=$ownerKey
            AND (a0.kind <> 'blurb' OR a0.deletedAt IS NULL) AND (b0.kind <> 'blurb' OR b0.deletedAt IS NULL)
          OPTIONAL MATCH (ah:OverlayEntity {ownerKey:$ownerKey, id:a0.mergedInto})
          OPTIONAL MATCH (bh:OverlayEntity {ownerKey:$ownerKey, id:b0.mergedInto})
          WITH l, coalesce(ah, a0) AS a, coalesce(bh, b0) AS b WHERE a <> b
          WITH a, b, l ORDER BY l.createdAt DESC, l.id DESC
          WITH a, b, l.relation AS relation, collect(l)[0] AS l
          RETURN ${EDGE} AS edge, a.id AS fromId, b.id AS toId, ${entityProjection('a')} AS fromEntity, ${entityProjection('b')} AS toEntity
          ORDER BY edge.createdAt DESC, edge.id DESC LIMIT $limit`,
        { ownerKey, ids: records, limit: neo4j.int(NEIGHBOURHOOD.links + 1) });
        const next: string[] = [];
        for (const record of rows.records) {
          const edge = { ...edgeFrom(record.get('edge') as Record<string, unknown>), fromId: String(record.get('fromId')), toId: String(record.get('toId')) };
          const key = JSON.stringify([edge.fromId, edge.relation, edge.toId]);
          if (links.has(key)) continue;
          const ends = ['fromEntity', 'toEntity'].map(key => entityFrom(record.get(key) as Record<string, unknown>));
          const unseen = ends.filter(end => !seen.has(end.id));
          if (links.size >= NEIGHBOURHOOD.links || entities.size + unseen.length > NEIGHBOURHOOD.entities) { truncated = true; continue; }
          links.set(key, edge);
          for (const other of unseen) { seen.add(other.id); entities.set(other.id, other); next.push(other.id); }
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
      const result = await tx.run(`MATCH (e:OverlayEntity {ownerKey: $ownerKey}) WHERE (e.cadenceDays IS NOT NULL OR e.intervalDays IS NOT NULL OR e.explicitNextDueAt IS NOT NULL) AND e.kind <> 'ask' AND e.mergedInto IS NULL
        RETURN e { .id, .name, ${CARD_PROPERTIES}, refs: ${refsOf('e')} } AS entity LIMIT 100000`, { ownerKey });
      return result.records.map(record => {
        const value = record.get('entity') as Record<string, unknown>;
        return { id: String(value.id), name: String(value.name), refs: (value.refs as string[]).slice().sort(), card: cardFrom(value) };
      })
        .filter(value => value.card.nextDueAt !== null && Date.parse(value.card.nextDueAt) <= now.getTime())
        .map(value => ({ id: value.id, name: value.name, refs: value.refs, important: value.card.important, nextDueAt: value.card.nextDueAt!, lastContactAt: value.card.lastContactAt }))
        .sort((a, b) => Date.parse(a.nextDueAt) - Date.parse(b.nextDueAt) || Number(b.important) - Number(a.important) || a.name.localeCompare(b.name));
    });
  }

  /**
   * Save an ask (see "Asks" in contract.ts): who cares (`author`: `'self'` or
   * `{id}` of the owner's person, company, project or idea, linked to the ask
   * as `asks`), optionally who carries it and where it is placed. The same author and text is one ask: a
   * repeated save returns it unchanged with `created: false`.
   */
  async saveAsk(principal: OverlayPrincipal | null, input: unknown, provenance?: unknown): Promise<{ ask: Ask; created: boolean }> {
    const ownerKey = this.owner(principal), ask = parseAskInput(input), by = cleanProvenance(provenance);
    if (ask.sourceReceipt && ask.sourceReceipt.app !== principal!.app) return fail(400, 'invalid_ask_source');
    return retryOnce(() => this.write(tx => saveAskIn(tx, ownerKey, ask, by)));
  }

  /** One ask with its parties. Anything that is not one of the owner's asks is 404. */
  async getAsk(principal: OverlayPrincipal | null, id: unknown): Promise<Ask> {
    const ownerKey = this.owner(principal);
    if (!isId(id)) return fail(404, 'not_found');
    return this.read(tx => askIn(tx, ownerKey, id));
  }

  /**
   * Edit an ask: text, horizon, recheckAfter, status, exposure (with
   * exposureChat), evidence, or `recheckedNow` (checked today: the next recheck
   * moves a horizon ahead and a stale ask is open again). Every edit counts
   * in `revision`; `updatedBy` records the editor, the original author stays.
   */
  async updateAsk(principal: OverlayPrincipal | null, id: unknown, patch: unknown, provenance?: unknown): Promise<Ask> {
    const ownerKey = this.owner(principal), change = parseAskPatch(patch), by = cleanProvenance(provenance);
    if (!isId(id)) return fail(404, 'not_found');
    try { return await this.write(tx => updateAskIn(tx, ownerKey, id, change, by)); }
    catch (error) {
      // Two edits racing to give two asks of one author the same text: the loser is a duplicate, not an outage.
      if ((error as { code?: string })?.code === 'Neo.ClientError.Schema.ConstraintValidationFailed') return fail(409, 'duplicate_ask');
      throw error;
    }
  }

  /**
   * The owner's asks, open and stale ones first by when they are due for a
   * recheck. Filter by `status` (default open and stale; `all`), `direction`
   * (`from_me`, `for_me`, `from_others`, `about:<entity id>`), text, and `needsRecheck`.
   */
  async listAsks(principal: OverlayPrincipal | null, filter: { status?: unknown; direction?: unknown; asker?: unknown; q?: unknown; needsRecheck?: unknown; limit?: unknown } = {}): Promise<{ asks: Ask[]; truncated: boolean }> {
    const ownerKey = this.owner(principal), parsed = parseAskFilter(filter);
    return this.read(tx => listAsksIn(tx, ownerKey, parsed));
  }

  /**
   * Merge two or more of the owner's people into one person (pointer merge,
   * docs/PEOPLE_OVERLAY.md "Merging people"). Nothing moves: each merged-away
   * record points at the head and reads answer for all of them. Needs a
   * verified actor, like source-card writes; idempotent on `operationId`.
   */
  async mergePeople(principal: OverlayPrincipal | null, raw: unknown, provenance?: unknown) {
    const ownerKey = this.owner(principal), input = parseMergeInput(raw), by = actorProvenance(principal!, provenance);
    return retryOnce(() => this.write(tx => mergeIn(tx, ownerKey, input, by)));
  }

  /** Up to 25 merges, each in its own transaction; results are indexed and succeed or fail independently. */
  async mergePeopleBatch(principal: OverlayPrincipal | null, raw: unknown, provenance?: unknown) {
    this.owner(principal);
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 25) return fail(400, 'invalid_merge_batch');
    const results: Array<Record<string, unknown>> = [];
    for (let index = 0; index < raw.length; index++) {
      try {
        const result = await this.mergePeople(principal, raw[index], provenance);
        results.push({ index, merged: result.merged, replayed: result.replayed, headId: result.headId, memberIds: result.memberIds, eventId: result.event?.id ?? null });
      } catch (error) {
        results.push({ index, error: error instanceof OverlayError && error.status < 500 ? error.code : 'merge_unavailable', ...(error instanceof OverlayError && error.details ? { details: error.details } : {}) });
      }
    }
    return { results };
  }

  /** Take one record out of its person; see `splitIn`. */
  async splitPerson(principal: OverlayPrincipal | null, raw: unknown, provenance?: unknown) {
    const ownerKey = this.owner(principal), input = parseSplitInput(raw), by = actorProvenance(principal!, provenance);
    return retryOnce(() => this.write(tx => splitIn(tx, ownerKey, input, by)));
  }

  /** Undo one merge event, or every merge in a batch; see `revertIn`. */
  async revertMerge(principal: OverlayPrincipal | null, raw: unknown, provenance?: unknown) {
    const ownerKey = this.owner(principal), input = parseRevertInput(raw), by = actorProvenance(principal!, provenance);
    return this.write(tx => revertIn(tx, ownerKey, input, by));
  }

  async listMergeEvents(principal: OverlayPrincipal | null, filter: { batchId?: unknown; entityId?: unknown; limit?: unknown } = {}) {
    const ownerKey = this.owner(principal);
    return this.read(tx => listMergeEventsIn(tx, ownerKey, filter));
  }

  /** Link browser projection: never loads source JSON, People state, notes or blurbs. */
  async exportOwnerLinks(principal: OverlayPrincipal | null) {
    const ownerKey = this.owner(principal);
    return this.read(async tx => {
      const links = await tx.run(`MATCH (a:OverlayEntity {ownerKey:$ownerKey})-[l:OVERLAY_LINK]->(b:OverlayEntity {ownerKey:$ownerKey})
        WHERE l.ownerKey=$ownerKey AND (a.kind <> 'blurb' OR a.deletedAt IS NULL) AND (b.kind <> 'blurb' OR b.deletedAt IS NULL)
        RETURN ${EDGE} AS edge, a.id AS fromId, b.id AS toId ORDER BY l.createdAt`, {ownerKey});
      const edges = links.records.map(row => ({...edgeFrom(row.get('edge') as Record<string,unknown>), fromId:String(row.get('fromId')), toId:String(row.get('toId'))}));
      const ids = [...new Set(edges.flatMap(edge => [edge.fromId, edge.toId]))];
      const entities = await tx.run(`MATCH (e:OverlayEntity {ownerKey:$ownerKey}) WHERE e.id IN $ids
        RETURN e { .id, .kind, .name, .description, refs:[(r:OverlayRef {ownerKey:$ownerKey})-[:REF_OF]->(e)|r.ref] } AS entity ORDER BY e.id`, {ownerKey,ids});
      return {entities:entities.records.map(row => row.get('entity')), links:edges};
    });
  }

  /** The owner's whole overlay as plain rows. */
  async exportOwner(principal: OverlayPrincipal | null): Promise<{ entities: unknown[]; notes: unknown[]; links: unknown[]; blurbs?: unknown; contactSources?: unknown[]; mergeEvents?: unknown[]; identityDecisions?: unknown[] }> {
    const ownerKey = this.owner(principal);
    return this.read(async tx => {
      const blurbState = await loadBlurbs(tx,ownerKey);
      const rows = async (query: string) => (await tx.run(query, { ownerKey })).records.map(record => record.get('row'));
      const contactSources=await rows('MATCH (s:OverlayContactSource {ownerKey:$ownerKey}) RETURN properties(s) AS row ORDER BY s.sourceKey');
      const merges = await exportMergesIn(tx, ownerKey);
      return {
        ...(merges.mergeEvents.length ? {mergeEvents: merges.mergeEvents} : {}),
        ...(merges.identityDecisions.length ? {identityDecisions: merges.identityDecisions} : {}),
        ...(blurbState.blurbs.length || blurbState.candidates.length || blurbState.conflicts.length ? {blurbs:blurbState} : {}),
        ...(contactSources.length ? {contactSources} : {}),
        // Note revisions and field history are exported only when there are any (older exports read unchanged).
        ...await (async () => {
          const noteRevisions = await rows('MATCH (r:OverlayNoteRevision {ownerKey: $ownerKey}) RETURN r { .id, .noteId, .entityId, .revision, .text, .author, .savedAt, .replacedAt, .replacedBy } AS row ORDER BY r.noteId, r.revision');
          const fieldAssertions = await rows('MATCH (a:OverlayFieldAssertion {ownerKey: $ownerKey}) RETURN properties(a) AS row ORDER BY a.recordedAt, a.id');
          const fieldDecisions = await rows('MATCH (d:OverlayFieldDecision {ownerKey: $ownerKey}) RETURN properties(d) AS row ORDER BY d.at, d.seq, d.id');
          return { ...(noteRevisions.length ? { noteRevisions } : {}), ...(fieldAssertions.length ? { fieldAssertions } : {}), ...(fieldDecisions.length ? { fieldDecisions } : {}) };
        })(),
        entities: (await rows(`MATCH (e:OverlayEntity {ownerKey: $ownerKey}) RETURN e { .id, .kind, .deletedAt, .name, .description, .important, .cadenceDays, .cadenceMode, .intervalDays, .lastContactAt, .explicitNextDueAt, .peopleState, .createdAt, .updatedAt,
          .mergedInto, .mergeEventId, ${ASK_PROPERTIES}, refs: [(r:OverlayRef)-[:REF_OF]->(e) | r.ref] } AS row ORDER BY e.createdAt`)).map(value => { const row=value as Record<string,unknown>; if(row.kind==='blurb') return row; const {deletedAt,mergedInto,mergeEventId,...legacy}=row; return {...legacy, ...(mergedInto ? {mergedInto, mergeEventId} : {})}; }),
        notes: await rows('MATCH (n:OverlayNote {ownerKey: $ownerKey}) RETURN n { .id, .entityId, .text, .createdAt, .updatedAt, .author, .source, .assertion, .revision, .editedBy } AS row ORDER BY n.createdAt'),
        links: (await rows(`MATCH (a:OverlayEntity {ownerKey: $ownerKey})-[l:OVERLAY_LINK]->(b:OverlayEntity {ownerKey:$ownerKey}) WHERE l.ownerKey=$ownerKey RETURN { id: l.id, fromId: a.id, relation: l.relation, relationType: l.relationType, toId: b.id,
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
      for (const ownerKey of [fromKey,toKey].sort()) await tx.run('MERGE (c:OverlayBlurbClock {ownerKey:$ownerKey}) ON CREATE SET c.sequence=0 SET c._lock=true REMOVE c._lock', {ownerKey});
      const occupied = (node: string) => ['OverlayEntity', 'OverlayBlurbRecord', 'OverlayBlurbOperation', ...MERGE_LABELS].map(label => `${node}:${label}`).join(' OR ');
      const counts = await tx.run(`OPTIONAL MATCH (a {ownerKey:$fromKey}) WHERE ${occupied('a')}
        WITH count(a) AS source OPTIONAL MATCH (b {ownerKey:$toKey}) WHERE ${occupied('b')}
        RETURN source,count(b) AS target`, {fromKey,toKey});
      if (!number(counts.records[0]?.get('source'))) return { moved:false };
      if (number(counts.records[0]?.get('target'))) return fail(409,'owner_conflict');
      await tx.run('MATCH (c:OverlayBlurbClock {ownerKey:$toKey}) DELETE c', {toKey});
      for (const label of ['OverlayBlurbRecord', 'OverlayBlurbClock', 'OverlayBlurbOperation', 'OverlayBlurbChange', 'OverlayBlurbVariant', 'OverlayBlurbVersion', 'OverlayBlurbTag', 'OverlayAskPublication', 'OverlayAskPublicationOperation', 'OverlayContactSource', 'OverlayPeopleOperation', 'OverlayAskSource', ...MERGE_LABELS, ...FIELD_LABELS, 'OverlayNoteRevision', 'OverlayNote', 'OverlayRef', 'OverlayEntity']) await tx.run(`MATCH (n:${label} {ownerKey: $fromKey}) SET n.ownerKey = $toKey`, { fromKey, toKey });
      await tx.run('MATCH (:OverlayEntity {ownerKey: $toKey})-[l:OVERLAY_LINK]->() SET l.ownerKey = $toKey', { toKey });
      return { moved: true };
    });
  }

  /**
   * Trusted app-level erasure, not an owner action: the person behind `ref`
   * left the app, so nobody keeps an overlay pointing at that ref. Retention
   * rules are in docs/PEOPLE_OVERLAY.md, "Address-book source cards and durable
   * People state" and "Merging people".
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
  await tx.run('MERGE (c:OverlayBlurbClock {ownerKey:$ownerKey}) ON CREATE SET c.sequence=0 SET c._lock=true REMOVE c._lock', {ownerKey});
  // Serialize erasure with publication writes on every existing canonical ask.
  await tx.run("MATCH (a:OverlayEntity {ownerKey:$ownerKey,kind:'ask'}) SET a._lock=true REMOVE a._lock", { ownerKey });
  for (const label of ['OverlayBlurbRecord', 'OverlayBlurbClock', 'OverlayBlurbOperation', 'OverlayBlurbChange', 'OverlayBlurbVariant', 'OverlayBlurbVersion', 'OverlayBlurbTag', 'OverlayAskPublication', 'OverlayAskPublicationOperation', 'OverlayContactSource', 'OverlayPeopleOperation', 'OverlayAskSource', ...MERGE_LABELS, ...FIELD_LABELS, 'OverlayNoteRevision', 'OverlayNote', 'OverlayRef', 'OverlayEntity']) await tx.run(`MATCH (n:${label} {ownerKey: $ownerKey}) DETACH DELETE n`, { ownerKey });
}

export async function purgeRefIn(tx: Pick<ManagedTransaction, 'run'>, rawRef: unknown): Promise<{ entitiesRemoved: number; refsRemoved: number }> {
  const ref = cleanRef(rawRef);
  const candidates = await tx.run(`MATCH (r:OverlayRef {ref:$ref})-[:REF_OF]->(e:OverlayEntity)
    RETURN DISTINCT e.ownerKey AS ownerKey,e.id AS id`, {ref});
  const initialRefs = await tx.run('MATCH (r:OverlayRef {ref:$ref}) RETURN count(r) AS total', {ref});
  const owners = [...new Set(candidates.records.map(record => String(record.get('ownerKey'))))].sort();
  for (const ownerKey of owners) await lockBlurbClock(tx, ownerKey);
  let entitiesRemoved = 0;
  for (const record of candidates.records) {
    const ownerKey=String(record.get('ownerKey')), id=String(record.get('id'));
    const eligible = await tx.run(`MATCH (e:OverlayEntity {ownerKey:$ownerKey,id:$id}) SET e._lock=true REMOVE e._lock
      WITH e WHERE EXISTS { MATCH (:OverlayRef {ref:$ref})-[:REF_OF]->(e) }
        AND NOT EXISTS { MATCH (other:OverlayRef)-[:REF_OF]->(e) WHERE other.ref <> $ref }
        AND NOT EXISTS { MATCH (s:OverlayContactSource {ownerKey:$ownerKey,entityId:$id}) }
        AND e.mergedInto IS NULL AND NOT EXISTS { MATCH (:OverlayEntity {ownerKey:$ownerKey, mergedInto:$id}) }
      RETURN e.id AS id`, {ownerKey,id,ref});
    if (eligible.records.length) { await deleteEntityIn(tx,ownerKey,id); entitiesRemoved++; }
  }
  await tx.run(`MATCH (a:OverlayEntity {kind: 'ask'}) WHERE $ref IN coalesce(a.placements, [])
    SET a.placements = [placement IN a.placements WHERE placement <> $ref]`, { ref });
  await tx.run('MATCH (r:OverlayRef {ref:$ref}) DETACH DELETE r', {ref});
  return {entitiesRemoved, refsRemoved:number(initialRefs.records[0]?.get('total'))};
}

/**
 * An entity is going: the asks it authored go with it (with their notes and
 * links; an ask is its author's), it stops carrying any, and it is dropped
 * from the placements of the rest. Returns how many asks went.
 */
async function releaseAskPartyIn(tx: Pick<ManagedTransaction, 'run'>, ownerKey: string, id: string): Promise<number> {
  const authored = await tx.run("MATCH (a:OverlayEntity {ownerKey:$ownerKey,kind:'ask'}) WHERE coalesce(a.askAuthorId,a.askerId)=$id RETURN a.id AS id", { ownerKey, id });
  for (const row of authored.records) await deleteEntityIn(tx, ownerKey, String(row.get('id')));
  await tx.run("MATCH (a:OverlayEntity {ownerKey: $ownerKey, kind: 'ask', carrierId: $id}) SET a.carrierId = null", { ownerKey, id });
  await tx.run(`MATCH (a:OverlayEntity {ownerKey: $ownerKey, kind: 'ask'}) WHERE ('entity:' + $id) IN coalesce(a.placements, [])
    SET a.placements = [placement IN a.placements WHERE placement <> 'entity:' + $id]`, { ownerKey, id });
  return authored.records.length;
}

/**
 * For callers that remove an entity together with their own records about it,
 * in one transaction. The asks that entity authored go with it (with their
 * notes and links: an ask is its author's); it stops carrying others and is
 * dropped from their placements.
 */
export async function deleteEntityIn(tx: Runner, ownerKey: string, id: string): Promise<{ notesRemoved: number; linksRemoved: number; refsRemoved: number; asksRemoved: number }> {
  if (!isOwnerKey(ownerKey)) return fail(400, 'invalid_owner');
  if (!isId(id)) return fail(404, 'not_found');
  await lockBlurbClock(tx, ownerKey);
  // Share the entity lock with note/link writes, source attachment and People/card
  // mutations so none can commit orphaned data or receipts during erasure.
  const found = await tx.run(`MATCH (e:OverlayEntity {id: $id, ownerKey: $ownerKey}) SET e._lock = true REMOVE e._lock
    RETURN size([(e)-[l:OVERLAY_LINK]-(:OverlayEntity {ownerKey: $ownerKey}) | l]) AS links, e.kind AS kind, e.mergedInto IS NOT NULL AS member,
      EXISTS { MATCH (m:OverlayEntity {ownerKey: $ownerKey, mergedInto: $id}) } AS head`, { id, ownerKey });
  if (!found.records.length) return fail(404, 'not_found');
  // Deleting through one record never silently erases a whole merged person: split it off first.
  if (found.records[0]!.get('member') === true) fail(409, 'merged_record');
  if (found.records[0]!.get('head') === true) fail(409, 'merged_person');
  if (found.records[0]?.get('kind') === 'blurb') fail(409, 'use_blurb_operations');
  const asksRemoved = found.records[0]?.get('kind') === 'ask' ? 0 : await releaseAskPartyIn(tx, ownerKey, id);
  // Owner erasure of a person also erases its note revisions and field history; nothing else ever deletes them.
  await tx.run('MATCH (r:OverlayNoteRevision {ownerKey: $ownerKey, entityId: $id}) DELETE r', { id, ownerKey });
  for (const label of FIELD_LABELS) await tx.run(`MATCH (f:${label} {ownerKey: $ownerKey, entityId: $id}) DELETE f`, { id, ownerKey });
  const notes = await tx.run('MATCH (n:OverlayNote {ownerKey: $ownerKey, entityId: $id}) DETACH DELETE n RETURN count(*) AS removed', { id, ownerKey });
  const refs = await tx.run('MATCH (r:OverlayRef {ownerKey: $ownerKey, entityId: $id}) DETACH DELETE r RETURN count(*) AS removed', { id, ownerKey });
  await tx.run('MATCH (s:OverlayContactSource {ownerKey:$ownerKey,entityId:$id}) DETACH DELETE s', {ownerKey,id});
  await tx.run('MATCH (r:OverlayPeopleOperation {ownerKey:$ownerKey}) WHERE coalesce(r.requestedId,r.entityId)=$id DETACH DELETE r', {ownerKey,id});
  await eraseAskPublicationIn(tx, ownerKey, id);
  await tx.run('MATCH (s:OverlayAskSource {ownerKey: $ownerKey, askId: $id}) DETACH DELETE s', { ownerKey, id });
  await tx.run('MATCH (e:OverlayEntity {id: $id, ownerKey: $ownerKey}) DETACH DELETE e', { id, ownerKey });
  return { notesRemoved: number(notes.records[0]?.get('removed')), linksRemoved: number(found.records[0]?.get('links')), refsRemoved: number(refs.records[0]?.get('removed')), asksRemoved };
}

/**
 * `ensure` inside the caller's transaction. Inputs must already be cleaned. A
 * `description` is stored on a new entity, and fills an existing entity's
 * blank one; it never replaces a description already there.
 */
export async function ensureIn(tx: Runner, ownerKey: string, input: { kind: EntityKind; name: string; ref: string | null; description?: string | null }): Promise<{ entity: Entity; created: boolean }> {
  if (!isOwnerKey(ownerKey)) return fail(400, 'invalid_owner');
  await lockBlurbClock(tx, ownerKey);
  // Asks are saved only through saveAskIn (their name follows their text and they never merge by name).
  if (input.kind === 'ask' || input.kind === 'blurb') return fail(400, 'invalid_kind');
  const { kind, name, ref } = input, description = input.description ?? null, now = new Date().toISOString();
  let existingId: string | undefined;
  if (ref) {
    const bound = await tx.run('MATCH (r:OverlayRef {ownerKey: $ownerKey, ref: $ref}) RETURN r.entityId AS id', { ownerKey, ref });
    existingId = bound.records[0]?.get('id') as string | undefined;
    if (existingId) {
      existingId = await headOf(tx, ownerKey, existingId) ?? existingId;
      const current = await entity(tx, ownerKey, existingId);
      if (current.kind !== kind) fail(409, 'kind_conflict');
      if (current.name !== name) await renameEntityIn(tx, ownerKey, existingId, name, kind, now);
    }
  } else {
    const named = await tx.run('MATCH (e:OverlayEntity {ownerKey: $ownerKey, nameSlot: $slot}) RETURN e.id AS id', { ownerKey, slot: nameSlot(kind, name) });
    existingId = named.records[0]?.get('id') as string | undefined;
  }
  if (existingId) {
    // A ref or name of a merged-away record names its person.
    existingId = await headOf(tx, ownerKey, existingId) ?? existingId;
    if (description !== null) await tx.run('MATCH (e:OverlayEntity {id: $id, ownerKey: $ownerKey}) WHERE e.description IS NULL SET e.description = $description, e.updatedAt = $now', { id: existingId, ownerKey, description, now });
    return { entity: await entity(tx, ownerKey, existingId), created: false };
  }
  await limit(tx, "MATCH (e:OverlayEntity {ownerKey: $ownerKey}) WHERE e.kind <> 'blurb' RETURN count(e) AS total", ownerKey, LIMITS.entitiesPerOwner, 'entity_limit');
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
  await lockBlurbClock(tx, ownerKey);
  const { kind, name, refs, description } = input;
  const found = await tx.run('UNWIND $refs AS ref OPTIONAL MATCH (r:OverlayRef {ownerKey: $ownerKey, ref: ref}) RETURN ref, r.entityId AS id', { ownerKey, refs });
  const boundTo = new Map(found.records.map(record => [String(record.get('ref')), (record.get('id') as string | null) ?? null]));
  const primary = refs.find(ref => boundTo.get(ref)) ?? refs[0]!;
  const { entity: current, created } = await ensureIn(tx, ownerKey, { kind, name, ref: primary, description });
  const unattached: string[] = [], now = new Date().toISOString();
  let count = current.refs.length;
  for (const ref of refs) {
    const bound = boundTo.get(ref);
    const owner = bound ? await headOf(tx, ownerKey, bound) ?? bound : null;
    if (ref === primary || owner === current.id) continue;
    if (owner || count >= LIMITS.refsPerEntity) { unattached.push(ref); continue; }
    await tx.run(`MATCH (e:OverlayEntity {id: $id, ownerKey: $ownerKey})
      CREATE (:OverlayRef {ownerKey: $ownerKey, ref: $ref, entityId: $id})-[:REF_OF]->(e)
      SET e.nameSlot = null, e.updatedAt = $now`, { id: current.id, ownerKey, ref, now });
    count++;
  }
  return { entity: await entity(tx, ownerKey, current.id), created, unattached };
}

export interface ResolveTarget { kind: NamedKind; name: string; requestId: string | null; description?: string | null }
export function cleanResolve(input: { kind?: unknown; name?: unknown; createNew?: unknown; clientRequestId?: unknown; description?: unknown }): ResolveTarget {
  const kind = cleanNamedKind(input?.kind), name = cleanName(input?.name), description = cleanDescription(input?.description);
  if (input.createNew === undefined || input.createNew === null || input.createNew === false) return { kind, name, requestId: null, description };
  // A deliberately separate entity needs a request id so a retry finds it instead of making a third.
  if (input.createNew !== true) return fail(400, 'invalid_create_new');
  return { kind, name, requestId: cleanRequestId(input.clientRequestId), description };
}

/** `resolve` inside the caller's transaction; `app` scopes the ref of a separate entity. */
export async function resolveIn(tx: Runner, ownerKey: string, app: string, target: ResolveTarget): Promise<{ entity: Entity; created: boolean }> {
  await lockBlurbClock(tx, ownerKey);
  const description = target.description ?? null;
  if (target.requestId !== null) return ensureIn(tx, ownerKey, { kind: target.kind, name: target.name, ref: separateRef(app, target.requestId), description });
  const found = await tx.run(`MATCH (x:OverlayEntity {ownerKey: $ownerKey, kind: $kind, nameKey: $nameKey})
    WITH DISTINCT coalesce(x.mergedInto, x.id) AS head MATCH (e:OverlayEntity {ownerKey: $ownerKey, id: head})
    RETURN e.id AS id, e.name AS name, e.description AS description, ${refsOf('e')} AS refs ORDER BY e.createdAt LIMIT 20`,
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

async function lockBlurbClock(tx: Runner, ownerKey: string): Promise<void> {
  await tx.run('MERGE (c:OverlayBlurbClock {ownerKey:$ownerKey}) ON CREATE SET c.sequence=0 SET c._lock=true REMOVE c._lock', {ownerKey});
}

/** `addNote` inside the caller's transaction. */
export async function addNoteIn(tx: Runner, ownerKey: string, entityId: string, rawText: string, provenance: Provenance): Promise<{ note: Note; created: boolean }> {
  if (!isOwnerKey(ownerKey)) return fail(400, 'invalid_owner');
  if (!isId(entityId)) return fail(404, 'not_found');
  const text = cleanText(rawText, LIMITS.noteLength, 'invalid_note');
  await lockBlurbClock(tx, ownerKey);
  // A note written to a merged-away record lands on its person's head; the same text on any of the person's records is the same note.
  entityId = await headOf(tx, ownerKey, entityId) ?? fail(404, 'not_found');
  // Locks the entity: two identical notes racing still become one.
  const locked = await tx.run("MATCH (e:OverlayEntity {id: $entityId, ownerKey: $ownerKey}) WHERE e.kind <> 'blurb' OR e.deletedAt IS NULL SET e._lock = true REMOVE e._lock RETURN e.id AS id", { entityId, ownerKey });
  if (!locked.records.length) return fail(404, 'not_found');
  const records = (await membersOf(tx, ownerKey, [entityId])).get(entityId)!;
  const same = await tx.run(`MATCH (n:OverlayNote {ownerKey: $ownerKey}) WHERE n.entityId IN $records AND n.text = $text RETURN ${NOTE} AS note ORDER BY n.createdAt LIMIT 1`, { ownerKey, records, text });
  if (same.records.length) return { note: noteFrom(same.records[0]!.get('note') as Record<string, unknown>), created: false };
  const count = await tx.run('MATCH (n:OverlayNote {ownerKey: $ownerKey, entityId: $entityId}) RETURN count(n) AS total', { ownerKey, entityId });
  if (number(count.records[0]?.get('total')) >= LIMITS.notesPerEntity) fail(409, 'note_limit');
  const now = new Date().toISOString();
  const note: Note = { id: nanoid(), text, createdAt: now, updatedAt: now, ...provenance, revision: 1 };
  await tx.run(`MATCH (e:OverlayEntity {id: $entityId, ownerKey: $ownerKey})
    CREATE (:OverlayNote {id: $id, ownerKey: $ownerKey, entityId: $entityId, text: $text, audience: 'owner', createdAt: $createdAt, updatedAt: $updatedAt,
      author: $author, source: $source, assertion: $assertion})-[:NOTE_ABOUT]->(e)`,
  { ...note, ownerKey, entityId });
  return { note, created: true };
}

export async function deleteNoteIn(tx: Runner, ownerKey: string, noteId: string): Promise<void> {
  if (!isOwnerKey(ownerKey)) return fail(400, 'invalid_owner');
  if (!isId(noteId)) return fail(404, 'not_found');
  await lockBlurbClock(tx, ownerKey);
  const result = await tx.run("MATCH (n:OverlayNote {id: $noteId, ownerKey: $ownerKey}) WHERE NOT EXISTS { MATCH (e:OverlayEntity {id: n.entityId, ownerKey: $ownerKey, kind: 'blurb'}) WHERE e.deletedAt IS NOT NULL } DETACH DELETE n RETURN count(*) AS removed", { noteId, ownerKey });
  if (!number(result.records[0]?.get('removed'))) fail(404, 'not_found');
  await tx.run('MATCH (r:OverlayNoteRevision {ownerKey: $ownerKey, noteId: $noteId}) DELETE r', { noteId, ownerKey });
}

/** `addLink` inside the caller's transaction. `attributes` as for `addLink` (cleaned again here). */
export async function addLinkIn(tx: Runner, ownerKey: string, fromId: string, rawRelation: string, toId: string, provenance: Provenance, attributes: LinkAttributeInput = {}): Promise<{ link: Link; created: boolean }> {
  if (!isOwnerKey(ownerKey)) return fail(400, 'invalid_owner');
  const relation = cleanRelation(rawRelation), extra = cleanLinkAttributes(attributes);
  if (!isId(fromId) || !isId(toId)) return fail(404, 'not_found');
  if (fromId === toId) return fail(400, 'self_link');
  await lockBlurbClock(tx, ownerKey);
  // Links join people: either end given as a merged-away record is its person's head.
  fromId = await headOf(tx, ownerKey, fromId) ?? fail(404, 'not_found');
  toId = await headOf(tx, ownerKey, toId) ?? fail(404, 'not_found');
  if (fromId === toId) return fail(400, 'self_link');
  // Locks the subject, so the limit check and the write see the same links.
  const locked = await tx.run("MATCH (a:OverlayEntity {id: $fromId, ownerKey: $ownerKey}) WHERE a.kind <> 'blurb' OR a.deletedAt IS NULL SET a._lock = true REMOVE a._lock RETURN a.kind AS kind", { fromId, ownerKey });
  if (!locked.records.length) return fail(404, 'not_found');
  const fromKind = locked.records[0]!.get('kind') as EntityKind;
  const other = await entity(tx, ownerKey, toId);
  const linkKey = JSON.stringify([fromId, relation, toId]);
  const groups = await membersOf(tx, ownerKey, [fromId, toId]);
  const existing = await tx.run(`MATCH (a:OverlayEntity {ownerKey:$ownerKey})-[l:OVERLAY_LINK]->(b:OverlayEntity {ownerKey:$ownerKey})
    WHERE a.id IN $fromIds AND b.id IN $toIds AND l.ownerKey=$ownerKey AND l.relation=$relation
    RETURN ${EDGE} AS edge ORDER BY l.createdAt DESC, l.id DESC LIMIT 1`, { fromIds: groups.get(fromId), toIds: groups.get(toId), ownerKey, relation });
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
  await lockBlurbClock(tx, ownerKey);
  const found = await tx.run(`MATCH (a:OverlayEntity {ownerKey: $ownerKey})-[l:OVERLAY_LINK {id: $linkId}]->(b:OverlayEntity {ownerKey: $ownerKey})
    WHERE l.ownerKey = $ownerKey AND (a.kind <> 'blurb' OR a.deletedAt IS NULL) AND (b.kind <> 'blurb' OR b.deletedAt IS NULL) SET a._lock = true REMOVE a._lock RETURN a.id AS fromId, b.id AS toId, a.kind AS fromKind, l.relation AS relation, ${ASKER_LINK} AS askerLink`, { ownerKey, linkId });
  const row = found.records[0];
  if (!row) return fail(404, 'not_found');
  if (row.get('askerLink') === true) fail(409, 'ask_fields');
  const fromId = String(row.get('fromId')), toId = String(row.get('toId')), fromKind = row.get('fromKind') as EntityKind;
  const fromHead = await headOf(tx, ownerKey, fromId) ?? fromId, toHead = await headOf(tx, ownerKey, toId) ?? toId;
  const other = await entity(tx, ownerKey, toHead);
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
  const clash = await tx.run(`MATCH (a:OverlayEntity {ownerKey:$ownerKey})-[m:OVERLAY_LINK]->(b:OverlayEntity {ownerKey:$ownerKey})
    WHERE coalesce(a.mergedInto,a.id)=$fromHead AND coalesce(b.mergedInto,b.id)=$toHead
      AND m.ownerKey=$ownerKey AND m.relation=$relation AND m.id <> $linkId
    RETURN m.id AS id ORDER BY m.createdAt DESC, m.id DESC LIMIT 1`, { fromHead, toHead, ownerKey, relation, linkId });
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
  await lockBlurbClock(tx, ownerKey);
  const found = await tx.run(`MATCH (a:OverlayEntity)-[l:OVERLAY_LINK {id: $linkId}]->(b:OverlayEntity) WHERE l.ownerKey = $ownerKey AND (a.kind <> 'blurb' OR a.deletedAt IS NULL) AND (b.kind <> 'blurb' OR b.deletedAt IS NULL) RETURN ${ASKER_LINK} AS askerLink`, { linkId, ownerKey });
  if (!found.records.length) return fail(404, 'not_found');
  // The author link goes only with its ask (or its author).
  if (found.records[0]!.get('askerLink') === true) fail(409, 'ask_fields');
  await tx.run('MATCH ()-[l:OVERLAY_LINK {id: $linkId}]->() WHERE l.ownerKey = $ownerKey DELETE l', { linkId, ownerKey });
}
/** Whether link `l` from `a` to `b` is an ask's author link (kept in step with the ask's askAuthorId). */
const ASKER_LINK = "(b.kind = 'ask' AND coalesce(b.askAuthorId, b.askerId) = a.id AND l.relation = 'asks')";

type Runner = Pick<ManagedTransaction, 'run'>;
const NEIGHBOURHOOD = { entities: 100, links: 200 } as const;
const nameSlot = (kind: EntityKind, name: string) => `${kind}\n${nameKey(name)}`;
async function renameEntityIn(tx: Runner, ownerKey: string, id: string, name: string, kind: EntityKind, now: string): Promise<void> {
  const physical = await tx.run(`MATCH (e:OverlayEntity {ownerKey:$ownerKey,id:$id})
    RETURN EXISTS { MATCH (:OverlayRef {ownerKey:$ownerKey})-[:REF_OF]->(e) } AS hasRefs`, { ownerKey, id });
  if (!physical.records.length) return fail(404, 'not_found');
  const slot = physical.records[0]!.get('hasRefs') === true ? null : nameSlot(kind, name);
  if (slot) {
    const clash = await tx.run('MATCH (e:OverlayEntity {ownerKey:$ownerKey,nameSlot:$slot}) WHERE e.id <> $id RETURN e.id AS id', { ownerKey, slot, id });
    if (clash.records.length) return fail(409, 'name_conflict');
  }
  await tx.run(`MATCH (e:OverlayEntity {ownerKey:$ownerKey,id:$id})
    SET e.name=$name, e.nameKey=$nameKey, e.nameSlot=$slot, e.kind=$kind, e.updatedAt=$now`,
  { ownerKey, id, name, nameKey: nameKey(name), slot, kind, now });
}
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
/** The fields only `ask` entities carry (author, source and assertion too: an ask records who saved it). */
const ASK_PROPERTIES = '.askOwn, .askerId, .askSources, .askText, .askAuthorSelf, .askAuthorId, .carrierSelf, .carrierId, .placements, .horizon, .recheckAfter, .askStatus, .exposure, .exposureChat, .evidenceQuote, .evidenceUrl, .evidenceLabel, .evidenceSeenAt, .evidenceNoteId, .closedAt, .checkedAt, .revision, .author, .source, .assertion, .updatedAt, .updatedBy';
const CARD_PROPERTIES = '.important, .cadenceDays, .cadenceMode, .intervalDays, .lastContactAt, .explicitNextDueAt, .cadenceSetAt, .createdAt';
const refsOf = (name: string) => `COLLECT { MATCH (refMember:OverlayEntity {ownerKey:$ownerKey})<-[:REF_OF]-(personRef:OverlayRef {ownerKey:$ownerKey})
  WHERE refMember.id = ${name}.id OR refMember.mergedInto = ${name}.id RETURN DISTINCT personRef.ref AS ref }`;
const entityProjection = (name: string) => `${name} { .id, .kind, .name, .description, ${CARD_PROPERTIES}, .peopleState, ${ASK_PROPERTIES}, refs: ${refsOf(name)} }`;
const ENTITY = entityProjection('e');
const NOTE = 'n { .id, .text, .createdAt, .updatedAt, .author, .source, .assertion, .revision, .editedBy }';
const edge = (name: string) => `${name} { .id, .relation, .relationType, .createdAt, .updatedAt, .updatedBy, .author, .source, .assertion, .since, .until, .context }`;
const EDGE = edge('l');
const end = (name: string) => `${name} { .id, .kind, .name, refs: ${refsOf(name)} }`;

function noteFrom(value: Record<string, unknown>): Note {
  return { id: String(value.id), text: String(value.text), createdAt: String(value.createdAt), updatedAt: String(value.updatedAt ?? value.createdAt), ...readProvenance(value),
    revision: Number(value.revision ?? 1) || 1, ...(typeof value.editedBy === 'string' ? { editedBy: value.editedBy } : {}) };
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

function cardFrom(value: Record<string, unknown>): Card {
  const card = {
    important: value.important === true, cadenceDays: optional(value.cadenceDays),
    cadenceMode: value.cadenceMode === 'expanding' ? 'expanding' as const : 'fixed' as const,
    intervalDays: optional(value.intervalDays), lastContactAt: typeof value.lastContactAt === 'string' ? value.lastContactAt : null,
  };
  const anchor = typeof value.cadenceSetAt === 'string' ? value.cadenceSetAt : String(value.createdAt);
  return { ...card, nextDueAt: typeof value.explicitNextDueAt === 'string' ? value.explicitNextDueAt : nextDue(card, anchor) };
}

function entityFrom(value: Record<string, unknown>): Entity {
  const peopleState = stateFrom(value.peopleState);
  return {
    id: String(value.id), kind: value.kind as EntityKind, name: String(value.name), description: textOrNull(value.description), refs: (value.refs as string[]).slice().sort(), card: cardFrom(value),
    ...(peopleState ? {peopleState} : {}),
    ...(value.kind === 'ask' ? { ask: askFieldsFrom(value) } : {}),
  };
}

/** An ask entity's fields as read back; anything unrecognised reads as its default. */
function askFieldsFrom(value: Record<string, unknown>, now = Date.now()): AskFields {
  const status = ASK_STATUSES.includes(value.askStatus as AskStatus) ? value.askStatus as AskStatus : 'open';
  const createdAt = String(value.createdAt), recheckAfter = textOrNull(value.recheckAfter) ?? createdAt;
  const evidence: AskEvidence = { quote: textOrNull(value.evidenceQuote), url: textOrNull(value.evidenceUrl), label: textOrNull(value.evidenceLabel), seenAt: textOrNull(value.evidenceSeenAt), noteId: textOrNull(value.evidenceNoteId) };
  const placements = Array.isArray(value.placements) ? value.placements as string[] : [];
  const record = readProvenance(value);
  return {
    sources: ((value.askSources as string[] | undefined) ?? []).map(raw => JSON.parse(raw) as AskSourceReceipt),
    text: textOrNull(value.askText) ?? String(value.name), fromMe: (value.askAuthorSelf ?? value.askOwn) === true, forMe: placements.includes('self') || value.carrierSelf === true,
    horizon: ASK_HORIZONS.includes(value.horizon as AskHorizon) ? value.horizon as AskHorizon : 'medium',
    recheckAfter, needsRecheck: status === 'stale' || (status === 'open' && Date.parse(recheckAfter) <= now), status,
    exposure: ASK_EXPOSURES.includes(value.exposure as AskExposure) ? value.exposure as AskExposure : 'only_me', exposureChat: textOrNull(value.exposureChat),
    evidence: Object.values(evidence).some(item => item !== null) ? evidence : null,
    createdAt, updatedAt: textOrNull(value.updatedAt) ?? createdAt, updatedBy: textOrNull(value.updatedBy), closedAt: textOrNull(value.closedAt), checkedAt: textOrNull(value.checkedAt),
    revision: number(value.revision), recordedBy: record.author, recordedVia: record.source, assertion: record.assertion,
  };
}
const SELF = { kind: 'self' as const };
function askFrom(value: Record<string, unknown>, author: Record<string, unknown> | null, carrier: Record<string, unknown> | null, placed: Array<Record<string, unknown> | null>): Ask {
  // Keyed by the id stored on the ask; a placement on a merged-away record reads as its person.
  const ends = new Map(placed.filter((end): end is Record<string, unknown> => end !== null).map(end => [String(end.pid ?? end.id), endFrom(end)]));
  const seen = new Set<string>();
  const placements: AskPlacement[] = (Array.isArray(value.placements) ? value.placements as string[] : []).flatMap((stored): AskPlacement[] =>
    stored === 'self' ? [SELF] : stored.startsWith('entity:') ? (ends.has(stored.slice(7)) ? [ends.get(stored.slice(7))!] : []) : [{ kind: 'ref', ref: stored }])
    .filter(placement => {
      const key = 'id' in placement ? `entity:${placement.id}` : placement.kind === 'ref' ? placement.ref : 'self';
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return {
    id: String(value.id), ...askFieldsFrom(value),
    author: (value.askAuthorSelf ?? value.askOwn) === true ? SELF : author ? endFrom(author) : null,
    carrier: value.carrierSelf === true ? SELF : carrier ? endFrom(carrier) : null,
    placements,
  };
}
/** Evidence as stored properties; null clears them all. */
const evidenceProperties = (evidence: AskEvidence | null) => ({
  evidenceQuote: evidence?.quote ?? null, evidenceUrl: evidence?.url ?? null, evidenceLabel: evidence?.label ?? null, evidenceSeenAt: evidence?.seenAt ?? null, evidenceNoteId: evidence?.noteId ?? null,
});
async function assertOwnNote(tx: Runner, ownerKey: string, evidence: AskEvidence | null | undefined): Promise<void> {
  if (!evidence?.noteId) return;
  const found = await tx.run('MATCH (n:OverlayNote {id: $id, ownerKey: $ownerKey}) RETURN n.id AS id', { id: evidence.noteId, ownerKey });
  if (!found.records.length) fail(400, 'invalid_evidence');
}
/** An entity named as a party must be one of the owner's, of a kind that can play that part. `lock` serialises saves by the same author. */
/** Returns the party as a person: a merged-away record's id is its head's. */
async function assertParty(tx: Runner, ownerKey: string, id: string, kinds: readonly EntityKind[], code: string, lock = false): Promise<string> {
  const head = await headOf(tx, ownerKey, id) ?? id;
  const found = await tx.run(`MATCH (a:OverlayEntity {id: $id, ownerKey: $ownerKey}) ${lock ? 'SET a._lock = true REMOVE a._lock ' : ''}RETURN a.kind AS kind`, { id: head, ownerKey });
  const kind = found.records[0]?.get('kind');
  if (kind === undefined) fail(404, 'not_found');
  if (!kinds.includes(kind as EntityKind)) fail(400, code);
  return head;
}
async function cleanPlacementsIn(tx: Runner, ownerKey: string, placements: AskPlacementRef[]): Promise<string[]> {
  const resolved: AskPlacementRef[] = [];
  for (const placement of placements) resolved.push('id' in placement ? { id: await assertParty(tx, ownerKey, placement.id, ASKER_KINDS, 'invalid_placement') } : placement);
  return [...new Set(resolved.map(placementKey))];
}
const partyProperties = (prefix: 'carrier', party: AskPartyRef | null) => ({ [`${prefix}Self`]: party !== null && 'self' in party, [`${prefix}Id`]: party !== null && 'id' in party ? party.id : null });
async function authorAskKeys(tx: Runner, ownerKey: string, authorId: string | null, text: string): Promise<string[]> {
  if (authorId === null) return [askKeyOf({ self: true }, text)];
  const head = await headOf(tx, ownerKey, authorId) ?? authorId;
  const ids = (await membersOf(tx, ownerKey, [head])).get(head)!;
  return ids.map(id => askKeyOf({ id }, text));
}
/**
 * The ask's parties, resolved within the owner's overlay (author, carrier and
 * the entities it was placed on), then its row. `carry` names variables to keep
 * in scope (for ordering).
 */
const askRows = (carry = '') => `
  OPTIONAL MATCH (author0:OverlayEntity {ownerKey: $ownerKey}) WHERE author0.id = coalesce(e.askAuthorId, e.askerId)
  OPTIONAL MATCH (authorHead:OverlayEntity {ownerKey: $ownerKey, id: author0.mergedInto})
  OPTIONAL MATCH (carrier0:OverlayEntity {ownerKey: $ownerKey, id: e.carrierId})
  OPTIONAL MATCH (carrierHead:OverlayEntity {ownerKey: $ownerKey, id: carrier0.mergedInto})
  WITH e, ${carry}coalesce(authorHead, author0) AS author, coalesce(carrierHead, carrier0) AS carrier
  CALL {
    WITH e
    UNWIND [x IN coalesce(e.placements, []) WHERE x STARTS WITH 'entity:' | substring(x, 7)] AS pid
    MATCH (p0:OverlayEntity {ownerKey: $ownerKey, id: pid})
    OPTIONAL MATCH (pHead:OverlayEntity {ownerKey: $ownerKey, id: p0.mergedInto})
    WITH pid, coalesce(pHead, p0) AS p
    RETURN collect(p { .id, .kind, .name, refs: ${refsOf('p')}, pid: pid }) AS placed
  }
  WITH e, ${carry}author, carrier, placed
  RETURN ${ENTITY} AS entity, CASE WHEN author IS NULL THEN null ELSE ${end('author')} END AS author,
    CASE WHEN carrier IS NULL THEN null ELSE ${end('carrier')} END AS carrier, placed`;
const askOfRow = (row: { get: (key: string) => unknown }): Ask =>
  askFrom(row.get('entity') as Record<string, unknown>, row.get('author') as Record<string, unknown> | null, row.get('carrier') as Record<string, unknown> | null, (row.get('placed') as Array<Record<string, unknown> | null>) ?? []);

/** One of the owner's asks with its parties, inside a transaction. */
export async function askIn(tx: Runner, ownerKey: string, id: string): Promise<Ask> {
  if (!isOwnerKey(ownerKey)) return fail(400, 'invalid_owner');
  const found = await tx.run(`MATCH (e:OverlayEntity {id: $id, ownerKey: $ownerKey, kind: 'ask'}) ${askRows()}`, { id, ownerKey });
  const row = found.records[0];
  return row ? askOfRow(row) : fail(404, 'not_found');
}

/** `saveAsk` inside the caller's transaction (OpenChat's note reviews). `input` as `parseAskInput` returns it. */
export async function saveAskIn(tx: Runner, ownerKey: string, input: AskInput, provenance: Provenance): Promise<{ ask: Ask; created: boolean }> {
  if (!isOwnerKey(ownerKey)) return fail(400, 'invalid_owner');
  await lockBlurbClock(tx, ownerKey);
  const receipt = input.sourceReceipt;
  const sourceKey = receipt ? createHash('sha256').update(JSON.stringify([receipt.app, receipt.conversationId, receipt.sourceMessageId ?? receipt.messageId, receipt.itemIndex])).digest('hex') : null;
  const requestHash = receipt ? createHash('sha256').update(JSON.stringify({ ...input, sourceReceipt: { ...receipt, sourceMessageId: receipt.sourceMessageId ?? receipt.messageId, messageId: receipt.sourceMessageId ?? receipt.messageId } })).digest('hex') : null;
  if (sourceKey) {
    const locked = await tx.run(`MERGE (s:OverlayAskSource {ownerKey: $ownerKey, sourceKey: $sourceKey})
      SET s._lock = true REMOVE s._lock RETURN s.askId AS askId, s.requestHash AS requestHash`, { ownerKey, sourceKey });
    const savedId = locked.records[0]?.get('askId');
    if (savedId) {
      if (locked.records[0]!.get('requestHash') !== requestHash) return fail(409, 'source_operation_conflict', { askId: savedId });
      return { ask: await askIn(tx, ownerKey, String(savedId)), created: false };
    }
  }
  const appendSource = async (id: string) => {
    if (!receipt) return;
    await tx.run('MATCH (e:OverlayEntity {ownerKey: $ownerKey, id: $id}) SET e._lock = true REMOVE e._lock', { ownerKey, id });
    const current = await askIn(tx, ownerKey, id);
    if (current.sources.length >= 100) return fail(409, 'ask_source_limit');
    const source: AskSourceReceipt = { ...receipt, recordedAt: new Date().toISOString(), recordedBy: provenance.author };
    await tx.run(`MATCH (e:OverlayEntity {ownerKey: $ownerKey, id: $id})
      SET e._lock = true REMOVE e._lock
      SET e.askSources = coalesce(e.askSources, []) + $source
      WITH e MATCH (s:OverlayAskSource {ownerKey: $ownerKey, sourceKey: $sourceKey})
      SET s.askId = e.id, s.requestHash = $requestHash`, { ownerKey, id, sourceKey, requestHash, source: JSON.stringify(source) });
  };
  // Locks the author: the same ask saved twice at once is still one. A merged-away author is its person.
  const authorId = 'id' in input.author ? await assertParty(tx, ownerKey, input.author.id, ASKER_KINDS, 'invalid_author', true) : null;
  const askKey = askKeyOf(authorId === null ? input.author : { id: authorId }, input.text);
  const askKeys = await authorAskKeys(tx, ownerKey, authorId, input.text);
  const existing = await tx.run('MATCH (e:OverlayEntity {ownerKey: $ownerKey, kind: \'ask\'}) WHERE e.askKey IN $askKeys RETURN e.id AS id ORDER BY e.createdAt, e.id LIMIT 1', { ownerKey, askKeys });
  if (existing.records.length) {
    const id = String(existing.records[0]!.get('id'));
    await appendSource(id);
    return { ask: await askIn(tx, ownerKey, id), created: false };
  }
  const carrier = input.carrier && 'id' in input.carrier ? { id: await assertParty(tx, ownerKey, input.carrier.id, CARRIER_KINDS, 'invalid_carrier') } : input.carrier;
  const placements = await cleanPlacementsIn(tx, ownerKey, input.placements);
  await assertOwnNote(tx, ownerKey, input.evidence);
  await limit(tx, "MATCH (e:OverlayEntity {ownerKey: $ownerKey, kind: 'ask'}) RETURN count(e) AS total", ownerKey, LIMITS.asksPerOwner, 'ask_limit');
  await limit(tx, "MATCH (e:OverlayEntity {ownerKey: $ownerKey}) WHERE e.kind <> 'blurb' RETURN count(e) AS total", ownerKey, LIMITS.entitiesPerOwner, 'entity_limit');
  const id = nanoid(), now = new Date().toISOString(), name = askName(input.text);
  const closed = input.status === 'fulfilled' || input.status === 'withdrawn';
  await tx.run(`CREATE (e:OverlayEntity {id: $id, ownerKey: $ownerKey, kind: 'ask', name: $name, nameKey: $nameKey, nameSlot: null, description: null,
    audience: 'owner', important: false, cadenceMode: 'fixed', createdAt: $now, updatedAt: $now})
    SET e += $fields`, {
    id, ownerKey, name, nameKey: nameKey(name), now,
    fields: {
      askText: input.text, askKey, askOwn: authorId === null, askerId: authorId, askAuthorSelf: authorId === null, askAuthorId: authorId, ...partyProperties('carrier', carrier), placements,
      horizon: input.horizon, recheckAfter: askRecheckAfter(input.horizon, now, input.recheckAfter),
      askStatus: input.status, exposure: input.exposure, exposureChat: input.exposureChat, ...evidenceProperties(input.evidence),
      closedAt: closed ? now : null, revision: neo4j.int(0), author: provenance.author, source: provenance.source, assertion: provenance.assertion,
    },
  });
  if (authorId !== null) await addLinkIn(tx, ownerKey, authorId, 'asks', id, provenance, { relationType: 'asks' });
  await appendSource(id);
  return { ask: await askIn(tx, ownerKey, id), created: true };
}

/** `updateAsk` inside the caller's transaction. `patch` as `parseAskPatch` returns it. */
export async function updateAskIn(tx: Runner, ownerKey: string, id: string, patch: AskPatch, provenance: Provenance): Promise<Ask> {
  if (!isOwnerKey(ownerKey)) return fail(400, 'invalid_owner');
  if (!isId(id)) return fail(404, 'not_found');
  await lockBlurbClock(tx, ownerKey);
  const locked = await tx.run("MATCH (e:OverlayEntity {id: $id, ownerKey: $ownerKey, kind: 'ask'}) SET e._lock = true REMOVE e._lock RETURN coalesce(e.askAuthorId, e.askerId) AS authorId", { id, ownerKey });
  if (!locked.records.length) return fail(404, 'not_found');
  const current = await askIn(tx, ownerKey, id), now = new Date().toISOString();
  const values: Record<string, unknown> = {};
  if (patch.text !== undefined && patch.text !== current.text) {
    const storedAuthor = locked.records[0]!.get('authorId') as string | null;
    const askKey = askKeyOf(storedAuthor ? { id: storedAuthor } : { self: true }, patch.text);
    const askKeys = await authorAskKeys(tx, ownerKey, storedAuthor, patch.text);
    const clash = await tx.run('MATCH (e:OverlayEntity {ownerKey: $ownerKey, kind: \'ask\'}) WHERE e.askKey IN $askKeys AND e.id <> $id RETURN e.id AS id LIMIT 1', { ownerKey, askKeys, id });
    if (clash.records.length) fail(409, 'duplicate_ask', { askId: String(clash.records[0]!.get('id')) });
    const name = askName(patch.text);
    Object.assign(values, { askText: patch.text, askKey, name, nameKey: nameKey(name) });
  }
  if (patch.carrier !== undefined) {
    const carrier = patch.carrier && 'id' in patch.carrier ? { id: await assertParty(tx, ownerKey, patch.carrier.id, CARRIER_KINDS, 'invalid_carrier') } : patch.carrier;
    Object.assign(values, partyProperties('carrier', carrier));
  }
  if (patch.placements !== undefined) values.placements = await cleanPlacementsIn(tx, ownerKey, patch.placements);
  const horizon = patch.horizon ?? current.horizon;
  if (patch.horizon !== undefined) values.horizon = patch.horizon;
  let status = patch.status ?? current.status;
  if (patch.recheckedNow) {
    values.checkedAt = now;
    if (current.status === 'stale' && patch.status === undefined) status = 'open';
  }
  if (patch.recheckAfter !== undefined || patch.recheckedNow || patch.horizon !== undefined) values.recheckAfter = askRecheckAfter(horizon, now, patch.recheckAfter ?? null);
  if (status === 'withdrawn') await revokeAskPublicationIn(tx, ownerKey, id);
  if (status !== current.status) {
    values.askStatus = status;
    values.closedAt = status === 'fulfilled' || status === 'withdrawn' ? (current.closedAt ?? now) : null;
  }
  if (patch.exposure !== undefined) Object.assign(values, { exposure: patch.exposure, exposureChat: patch.exposureChat ?? null });
  if (patch.evidence !== undefined) {
    await assertOwnNote(tx, ownerKey, patch.evidence);
    Object.assign(values, evidenceProperties(patch.evidence));
  }
  Object.assign(values, { updatedAt: now, updatedBy: provenance.author, revision: neo4j.int(current.revision + 1) });
  await tx.run('MATCH (e:OverlayEntity {id: $id, ownerKey: $ownerKey}) SET e += $values', { id, ownerKey, values });
  return askIn(tx, ownerKey, id);
}

/** `listAsks` inside a transaction. `filter` as `parseAskFilter` returns it. */
export async function listAsksIn(tx: Runner, ownerKey: string, filter: AskFilter, now = new Date()): Promise<{ asks: Ask[]; truncated: boolean }> {
  if (!isOwnerKey(ownerKey)) return fail(400, 'invalid_owner');
  // An entity filter means the person: asks by, carried by or placed on any of its records.
  const recordsOf = async (id: string | null | undefined): Promise<string[] | null> => {
    if (!id) return null;
    const head = await headOf(tx, ownerKey, id);
    return head === null ? [id] : (await membersOf(tx, ownerKey, [head])).get(head)!;
  };
  const aboutIds = await recordsOf(filter.about), authorIds = await recordsOf(filter.authorId);
  const found = await tx.run(`MATCH (e:OverlayEntity {ownerKey: $ownerKey, kind: 'ask'})
    WITH e, coalesce(e.askStatus, 'open') AS status, coalesce(e.askAuthorSelf, e.askOwn, false) AS fromMe,
      ('self' IN coalesce(e.placements, []) OR coalesce(e.carrierSelf, false)) AS forMe
    WHERE ($statuses IS NULL OR status IN $statuses)
      AND ($direction IS NULL OR ($direction = 'from_me' AND fromMe) OR ($direction = 'from_others' AND NOT fromMe) OR ($direction = 'for_me' AND forMe))
      AND ($authorIds IS NULL OR coalesce(e.askAuthorId, e.askerId) IN $authorIds)
      AND ($aboutIds IS NULL OR coalesce(e.askAuthorId, e.askerId) IN $aboutIds OR e.carrierId IN $aboutIds OR any(id IN $aboutIds WHERE ('entity:' + id) IN coalesce(e.placements, [])))
      AND ($q = '' OR toLower(coalesce(e.askText, e.name)) CONTAINS $q)
      AND (NOT $needsRecheck OR status = 'stale' OR (status = 'open' AND coalesce(e.recheckAfter, e.createdAt) <= $now))
    ${askRows('status, ')}
    ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'stale' THEN 1 ELSE 2 END, CASE WHEN status IN ['open', 'stale'] THEN coalesce(e.recheckAfter, e.createdAt) ELSE '' END,
      coalesce(e.updatedAt, e.createdAt) DESC, e.id
    LIMIT $limit`,
  { ownerKey, statuses: filter.status, direction: filter.direction, aboutIds, authorIds, q: filter.q, needsRecheck: filter.needsRecheck, now: now.toISOString(), limit: neo4j.int(filter.limit + 1) });
  return { asks: found.records.slice(0, filter.limit).map(askOfRow), truncated: found.records.length > filter.limit };
}

async function entity(tx: Runner, ownerKey: string, id: string): Promise<Entity> {
  const result = await tx.run(`MATCH (e:OverlayEntity {id: $id, ownerKey: $ownerKey}) WHERE e.kind <> 'blurb' OR e.deletedAt IS NULL RETURN ${ENTITY} AS entity`, { id, ownerKey });
  const found = result.records[0]?.get('entity') as Record<string, unknown> | undefined;
  // Missing and someone else's are the same answer.
  return found ? entityFrom(found) : fail(404, 'not_found');
}

async function detail(tx: Runner, ownerKey: string, id: string): Promise<EntityDetail> {
  // A merged-away id answers for its person: the head plus every member, with `requestedId` saying what was asked for.
  const head = await headOf(tx, ownerKey, id);
  if (head === null) return fail(404, 'not_found');
  const base = await entity(tx, ownerKey, head);
  const ids = (await membersOf(tx, ownerKey, [head])).get(head)!;
  const merged = ids.length > 1;
  const bySource = await sourcesIn(tx as ManagedTransaction, ownerKey, ids);
  const contactSources = ids.flatMap(member => (bySource.get(member) ?? []).map(source => merged ? { ...source, memberId: member } : source));
  const notes = await tx.run(`MATCH (n:OverlayNote {ownerKey: $ownerKey}) WHERE n.entityId IN $ids
    RETURN ${NOTE} AS note ORDER BY n.createdAt DESC LIMIT $limit`, { ownerKey, ids, limit: neo4j.int(LIMITS.notesPerEntity * ids.length) });
  const links = await clusterLinks(tx, ownerKey, ids, 500);
  const extra: Partial<EntityDetail> = {};
  if (merged) {
    const refs = await tx.run('MATCH (r:OverlayRef {ownerKey: $ownerKey})-[:REF_OF]->(e:OverlayEntity {ownerKey: $ownerKey}) WHERE e.id IN $ids RETURN collect(DISTINCT r.ref) AS refs', { ownerKey, ids });
    extra.refs = ((refs.records[0]?.get('refs') as string[]) ?? []).slice().sort();
    extra.members = (await memberSummaries(tx, ownerKey, [head])).get(head);
  }
  const noteList = notes.records.map(record => noteFrom(record.get('note') as Record<string, unknown>));
  const { fields, suggestions } = base.kind === 'person' ? await fieldsIn(tx, ownerKey, { headId: head, ids, notes: noteList, sources: contactSources }) : { fields: undefined, suggestions: undefined };
  return {
    ...base, ...extra, ...(head !== id ? { requestedId: id } : {}), contactSources,
    notes: noteList,
    links, ...(fields ? { fields, fieldSuggestions: suggestions } : {}),
  };
}

/** The person (head and members), its notes and source cards: what fields are computed from. */
async function fieldContext(tx: Runner, ownerKey: string, id: string): Promise<FieldContext> {
  const head = await headOf(tx, ownerKey, id);
  if (head === null) return fail(404, 'not_found');
  const kind = await tx.run('MATCH (e:OverlayEntity {ownerKey:$ownerKey, id:$head}) RETURN e.kind AS kind', { ownerKey, head });
  if (kind.records[0]?.get('kind') !== 'person') return fail(409, 'fields_people_only');
  const ids = (await membersOf(tx, ownerKey, [head])).get(head)!;
  const bySource = await sourcesIn(tx as ManagedTransaction, ownerKey, ids);
  const sources = ids.flatMap(member => (bySource.get(member) ?? []).map(source => ({ ...source, memberId: member })));
  const notes = await tx.run(`MATCH (n:OverlayNote {ownerKey: $ownerKey}) WHERE n.entityId IN $ids RETURN ${NOTE} AS note ORDER BY n.createdAt DESC LIMIT $limit`,
    { ownerKey, ids, limit: neo4j.int(LIMITS.notesPerEntity * ids.length) });
  return { headId: head, ids, sources, notes: notes.records.map(record => noteFrom(record.get('note') as Record<string, unknown>)) };
}
async function fieldsIn(tx: Runner, ownerKey: string, ctx: FieldContext, reveal = false) {
  const stored = await storedAssertionsIn(tx, ownerKey, ctx.ids);
  const fields = projectFields([...stored.assertions, ...sourceAssertions(ctx.sources, ctx.headId)], stored.decisions, reveal);
  return { fields, suggestions: fieldSuggestions(ctx.notes, fields, stored.decisions, reveal) };
}

export interface NoteRevision { revision: number; text: string; author: string | null; savedAt: string; replacedAt: string; replacedBy: string | null }

/** `updateNote` inside the caller's transaction. */
export async function updateNoteIn(tx: Runner, ownerKey: string, noteId: string, text: string, ifRevision: number | null, by: Provenance): Promise<Note> {
  await lockBlurbClock(tx, ownerKey);
  const found = await tx.run(`MATCH (n:OverlayNote {id: $noteId, ownerKey: $ownerKey}) WHERE NOT EXISTS { MATCH (e:OverlayEntity {id: n.entityId, ownerKey: $ownerKey, kind: 'blurb'}) WHERE e.deletedAt IS NOT NULL }
    RETURN ${NOTE} AS note, n.entityId AS entityId`, { noteId, ownerKey });
  const row = found.records[0];
  if (!row) return fail(404, 'not_found');
  const current = noteFrom(row.get('note') as Record<string, unknown>);
  if (ifRevision !== null && ifRevision !== current.revision) return fail(409, 'stale_revision', { note: current, revision: current.revision });
  if (current.text === text) return current;
  const now = new Date().toISOString(), revision = (current.revision ?? 1) + 1;
  // The replaced text is kept, never overwritten: one immutable revision per edit.
  await tx.run(`CREATE (:OverlayNoteRevision {id: $id, ownerKey: $ownerKey, noteId: $noteId, entityId: $entityId, revision: $old, text: $oldText, author: $oldAuthor,
    savedAt: $savedAt, replacedAt: $now, replacedBy: $by})`, { id: nanoid(), ownerKey, noteId, entityId: row.get('entityId'), old: current.revision ?? 1, oldText: current.text,
    oldAuthor: current.editedBy ?? current.author, savedAt: current.updatedAt, now, by: by.author });
  const updated = await tx.run(`MATCH (n:OverlayNote {id: $noteId, ownerKey: $ownerKey}) SET n.text = $text, n.updatedAt = $now, n.revision = $revision, n.editedBy = $by RETURN ${NOTE} AS note`,
    { noteId, ownerKey, text, now, revision, by: by.author });
  return noteFrom(updated.records[0]!.get('note') as Record<string, unknown>);
}

/**
 * The links of a person and its merged records, as the person's: links
 * between two of its records are left out, the other end is shown as its own
 * person (head), and the same relation to the same person read through
 * several records shows once (the newest).
 */
async function clusterLinks(tx: Runner, ownerKey: string, ids: string[], max: number): Promise<Link[]> {
  const rows = await tx.run(`MATCH (e:OverlayEntity {ownerKey: $ownerKey})-[l:OVERLAY_LINK]-(other:OverlayEntity {ownerKey: $ownerKey})
    WHERE e.id IN $ids AND NOT other.id IN $ids AND l.ownerKey = $ownerKey AND (e.kind <> 'blurb' OR e.deletedAt IS NULL) AND (other.kind <> 'blurb' OR other.deletedAt IS NULL)
    OPTIONAL MATCH (otherHead:OverlayEntity {ownerKey: $ownerKey, id: other.mergedInto})
    WITH l, e, coalesce(otherHead, other) AS shown WHERE NOT shown.id IN $ids
    WITH shown, l, CASE WHEN startNode(l) = e THEN 'out' ELSE 'in' END AS direction ORDER BY l.createdAt DESC, l.id DESC
    WITH shown, direction, l.relation AS relation, collect(l)[0] AS l
    RETURN ${EDGE} AS edge, direction, ${end('shown')} AS other
    ORDER BY l.createdAt DESC, l.id DESC LIMIT $limit`, { ownerKey, ids, limit: neo4j.int(max) });
  const seen = new Set<string>(), links: Link[] = [];
  for (const record of rows.records) {
    const link = linkFrom(edgeFrom(record.get('edge') as Record<string, unknown>), record.get('direction') as 'out' | 'in', endFrom(record.get('other') as Record<string, unknown>));
    const key = JSON.stringify([link.direction, link.relation, link.other.id]);
    if (seen.has(key)) continue;
    seen.add(key); links.push(link);
  }
  return links;
}

async function limit(tx: Runner, query: string, ownerKey: string, max: number, code: string): Promise<void> {
  const count = await tx.run(query, { ownerKey });
  if (number(count.records[0]?.get('total')) >= max) fail(409, code);
}

async function writeCard(tx: Runner, ownerKey: string, id: string, current: Card, patch: CardPatch, now: string): Promise<string | null> {
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
  const result = await tx.run(`MATCH (e:OverlayEntity {id: $id, ownerKey: $ownerKey})
    SET e.important = $important, e.cadenceDays = $cadenceDays, e.cadenceMode = $cadenceMode, e.intervalDays = $intervalDays,
        e.lastContactAt = $lastContactAt, e.updatedAt = $now,
        e.explicitNextDueAt = CASE WHEN $cadenceChanged OR $contactedNow THEN NULL ELSE e.explicitNextDueAt END,
        e.cadenceSetAt = CASE WHEN $cadenceChanged OR e.cadenceSetAt IS NULL THEN $now ELSE e.cadenceSetAt END
    RETURN e.explicitNextDueAt AS explicitNextDueAt`,
  { id, ownerKey, now, important: next.important, cadenceMode: next.cadenceMode, lastContactAt: next.lastContactAt, cadenceChanged, contactedNow: patch.contactedNow === true,
    cadenceDays: next.cadenceDays === null ? null : neo4j.int(next.cadenceDays), intervalDays: next.intervalDays === null ? null : neo4j.int(next.intervalDays) });
  return result.records[0]?.get('explicitNextDueAt') ?? null;
}

export { OverlayError };

const pageScope = (parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const pageCursor = (scope: string, after: string) => Buffer.from(JSON.stringify({ scope, after })).toString('base64url');
function pageInput(input: { after?: unknown; limit?: unknown }, scope: string): { after: string; limit: number } {
  let after = '';
  if (input.after !== undefined) {
    if (typeof input.after !== 'string' || input.after.length > 512 || !/^[A-Za-z0-9_-]+$/.test(input.after)) return fail(400, 'invalid_cursor');
    try {
      const decoded = JSON.parse(Buffer.from(input.after, 'base64url').toString('utf8'));
      if (decoded.scope !== scope || !isId(decoded.after)) return fail(400, 'invalid_cursor');
      after = decoded.after;
    } catch { return fail(400, 'invalid_cursor'); }
  }
  if (input.limit !== undefined && typeof input.limit !== 'number' && (typeof input.limit !== 'string' || !/^[0-9]+$/.test(input.limit))) return fail(400, 'invalid_limit');
  const limit = input.limit === undefined ? 100 : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return fail(400, 'invalid_limit');
  return { after, limit };
}
