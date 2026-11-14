/**
 * Private graph — a person's own notes, importance, catch-up cadence and links
 * about the people they know.
 *
 * Storage is the Noos people overlay (`./overlay/`, kept in step with
 * `src/overlay/` in the Noos repository), in the graph database OpenChat
 * shares with Noos. OpenChat is one view of it: a person here is the overlay
 * entity named by the ref `openchat:user:<id>`, and another app can point at
 * the same entity with its own ref. Every overlay node and link carries the
 * owner's key and every query is anchored on it; the person a note or link is
 * about never sees it, and nothing here is read by search, matching or other
 * people's profiles.
 *
 * This file is OpenChat's side of that: who may be written about (no bots, no
 * blocks, not yourself), which identity names the owner, how Unlinked refs are
 * confirmed, and the response shapes the app and agent tools already use. The
 * overlay's rules themselves (name ambiguity, idempotency, provenance,
 * relation types and edits) live only in the vendored Noos store.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Driver } from 'neo4j-driver';
import { getDriver } from '../db.js';
import { DEFAULT_PUBLIC_DISPLAY_NAME } from '../privacy/profilePrivacy.js';
import { ASK_EXPOSURES, ASK_HORIZONS, ASK_STATUSES, cleanName, cleanRef, linkedinHashOf, parseAskInput, parseAskPatch, linkedinRef, OverlayError, OWNER_PROVENANCE, ownerKeyFor, RELATION_TYPES } from './overlay/contract.js';
import type { Ask, AskEvidence, AskExposure, AskHorizon, AskStatus, Candidate, Edge, Entity, EntityDetail, Link as OverlayLink, LinkEnd as OverlayLinkEnd, OverlayPrincipal, Provenance, RelationType } from './overlay/contract.js';
import { deleteEntityIn, deleteNoteIn, deleteOwnerIn, ensureIn, OverlayStore, purgeRefIn } from './overlay/store.js';
import { lookupUnlinkedContactForIdentity, lookupUnlinkedContactsByHash } from './unlinkedProvision.js';
import type { UnlinkedContact } from './unlinkedProvision.js';

export class PrivateGraphError extends Error {
  /** Extra response fields, such as the candidates for an ambiguous name. */
  constructor(public status: number, message: string, public details?: Record<string, unknown>) { super(message); }
}

/**
 * `topic` (2026-10-10) is a thing in the world people and projects are about
 * (ADHD, coherence), not something the owner might do. `list` (Noos #105,
 * 2026-11-05) is an owner-private collection: its members are outgoing
 * `contains` links to people (see "Lists" below).
 */
export const THING_KINDS = ['person', 'company', 'idea', 'project', 'topic', 'list'] as const;
/** What a note review may propose linking to: lists are curated by hand, never inferred from a note. */
export const REVIEW_KINDS = ['person', 'company', 'idea', 'project', 'topic'] as const;
const KIND_CHOICE = 'Choose a person, company, idea, project, topic or list';
export type ThingKind = typeof THING_KINDS[number];
/** `ask` ends appear on links to an ask (a person `asks` it) and in search; asks are saved through the ask routes, never as things. */
export type NodeKind = 'user' | Entity['kind'];
export type CadenceMode = 'fixed' | 'expanding';

export interface PersonCard {
  important: boolean;
  cadenceDays: number | null;
  cadenceMode: CadenceMode;
  intervalDays: number | null;
  lastContactAt: string | null;
  nextDueAt: string | null;
}
export type { Provenance, RelationType };
export { RELATION_TYPES, OWNER_PROVENANCE };
/** author, source and assertion are null on notes and links written before provenance existed. */
/** `revision` counts edits (1 when never edited); `editedBy` wrote the latest edit. */
export interface PrivateNote extends Provenance { id: string; text: string; createdAt: string; updatedAt: string; revision?: number; editedBy?: string }
/**
 * `unlinkedProfileId` is set when the end is a published Unlinked profile
 * (overlay ref `unlinked:person:<id>`); `linkedinRefHash` when it is one of the
 * owner's imported LinkedIn contacts (ref `linkedin:in:<hash>`), with
 * `unlinkedConnectionId` (the id from unlinked_list_connections) when Unlinked
 * could name it. `id` is then its saved-thing id.
 */
export interface LinkEnd { kind: NodeKind; id: string; name: string; description?: string; unlinkedProfileId?: string; linkedinRefHash?: string; unlinkedConnectionId?: string }
/**
 * `since`, `until` (free date text) and `context` are null when not given;
 * `updatedBy` is the author of the last in-place edit (the original `author` stays).
 */
export interface LinkFacts { since: string | null; until: string | null; context: string | null; updatedBy: string | null }
export interface PrivateLink extends Provenance, LinkFacts { id: string; relation: string; relationType: RelationType; direction: 'out' | 'in'; other: LinkEnd; createdAt: string; updatedAt: string | null }
export interface PersonBasics { id: string; name: string; avatarUrl: string | null }
export interface PersonOverlay { userId: string; person: PersonBasics; card: PersonCard; notes: PrivateNote[]; links: PrivateLink[] }
/** `description` is the owner's one-line summary, null when none was given. */
export interface Thing { id: string; kind: ThingKind; name: string; description: string | null }
export interface ThingDetail extends Thing { card?: PersonCard; peopleState?: unknown; contactSources?: unknown[]; fields?: unknown[]; fieldSuggestions?: unknown[]; notes: PrivateNote[]; links: PrivateLink[]; unlinkedProfileId?: string; linkedinRefHash?: string; unlinkedConnectionId?: string }
/** An Unlinked person: a published profile (`profileId`) and/or one of the owner's imported contacts (`connectionId`, `linkedinRefHash`). */
export interface UnlinkedPersonOverlay { profileId: string | null; connectionId: string | null; linkedinRefHash: string | null; thingId: string | null; name: string | null; card: PersonCard; notes: PrivateNote[]; links: PrivateLink[] }
export interface OwnerLink extends Provenance, LinkFacts { id: string; relation: string; relationType: RelationType; from: LinkEnd; to: LinkEnd; createdAt: string; updatedAt: string | null }
export interface PrivateSearch { things: Array<LinkEnd & { matched: Array<'name' | 'description' | 'note'> }>; links: OwnerLink[]; truncated: boolean }
export interface PrivateNeighbourhood { center: LinkEnd; depth: 1 | 2; nodes: LinkEnd[]; links: OwnerLink[]; truncated: boolean }
/** Who a link or note is about: an OpenChat person, a saved thing, or an Unlinked person (published profile id, owner connection id or LinkedIn address). */
export type Subject = { kind: 'user' | 'thing' | 'unlinked'; id: string };
export interface DuePerson { userId: string; name: string; avatarUrl: string | null; important: boolean; nextDueAt: string; lastContactAt: string | null }

export const LIMITS = { noteLength: 4000, notesPerSubject: 200, linksPerOwner: 5000, thingsPerOwner: 100000, relationLength: 60, nameLength: 120, cadenceDays: 3650 } as const;
const EXPANDING_FACTOR = 1.6;
const EXPANDING_CEILING_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;
const EMPTY_CARD: PersonCard = { important: false, cadenceDays: null, cadenceMode: 'fixed', intervalDays: null, lastContactAt: null, nextDueAt: null };

const fail = (status: number, message: string, details?: Record<string, unknown>): never => { throw new PrivateGraphError(status, message, details); };

export function cleanText(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string') return fail(400, `${label} is required`);
  // Control characters other than newline and tab never belong in a note or a name.
  // eslint-disable-next-line no-control-regex -- deliberate control-character strip
  const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (!text) return fail(400, `${label} is required`);
  if (text.length > max) return fail(400, `${label} is too long`);
  return text;
}

export const nameKey = (name: string): string => name.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/** The relation is the owner's own words ("knows", "works at", "interested in"). */
export function cleanRelation(value: unknown): string {
  return cleanText(value, LIMITS.relationLength, 'Relation').replace(/\s+/g, ' ').toLowerCase();
}

/**
 * When someone is next due. Fixed cadence repeats the same gap; expanding
 * cadence stretches the gap each time you catch up, the way spaced repetition
 * does, up to a year.
 */
export function nextDue(card: Pick<PersonCard, 'cadenceDays' | 'intervalDays' | 'lastContactAt'>, anchor: string): string | null {
  const interval = card.intervalDays ?? card.cadenceDays;
  if (!interval) return null;
  const from = Date.parse(card.lastContactAt ?? anchor);
  return Number.isFinite(from) ? new Date(from + interval * DAY_MS).toISOString() : null;
}

export function intervalAfterContact(card: Pick<PersonCard, 'cadenceDays' | 'cadenceMode' | 'intervalDays'>, hadPriorContact: boolean): number | null {
  if (!card.cadenceDays) return null;
  if (card.cadenceMode !== 'expanding' || !hadPriorContact) return card.intervalDays ?? card.cadenceDays;
  // The ceiling never pulls a gap below the cadence the owner chose (a two-year cadence stays two years).
  return Math.min(Math.max(EXPANDING_CEILING_DAYS, card.cadenceDays), Math.max(card.cadenceDays, Math.round((card.intervalDays ?? card.cadenceDays) * EXPANDING_FACTOR)));
}

export interface CardPatch { important?: boolean; cadenceDays?: number | null; cadenceMode?: CadenceMode; contactedNow?: boolean }

export function parseCardPatch(body: unknown): CardPatch {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'Nothing to change');
  const input = body as Record<string, unknown>, patch: CardPatch = {};
  if ('important' in input) {
    if (typeof input.important !== 'boolean') return fail(400, 'important must be true or false');
    patch.important = input.important;
  }
  if ('cadenceDays' in input) {
    const days = input.cadenceDays;
    if (days !== null && (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > LIMITS.cadenceDays)) return fail(400, 'cadenceDays must be a whole number of days, or null');
    patch.cadenceDays = days as number | null;
  }
  if ('cadenceMode' in input) {
    if (input.cadenceMode !== 'fixed' && input.cadenceMode !== 'expanding') return fail(400, 'cadenceMode must be fixed or expanding');
    patch.cadenceMode = input.cadenceMode;
  }
  if ('contactedNow' in input) {
    if (input.contactedNow !== true) return fail(400, 'contactedNow must be true');
    patch.contactedNow = true;
  }
  if (!Object.keys(patch).length) return fail(400, 'Nothing to change');
  return patch;
}

export type LinkTarget =
  | { kind: 'user'; id: string }
  | { kind: 'unlinked'; id: string }
  | { kind: ThingKind; id: string }
  | { kind: ThingKind; name: string; createNew?: { requestId: string } };

/** An Unlinked public profile id, as Unlinked's agent tools return it. */
const UNLINKED_PROFILE_ID = /^[A-Za-z0-9._-]{1,160}$/;
export function cleanUnlinkedProfileId(value: unknown): string {
  if (typeof value !== 'string' || !UNLINKED_PROFILE_ID.test(value)) return fail(400, 'Use an Unlinked profile id, a connection id from unlinked_list_connections, or a linkedin.com/in/ address');
  return value;
}
/**
 * What an Unlinked id names: an owner connection id (64 hex, from
 * unlinked_list_connections), a LinkedIn profile address, or otherwise a
 * published profile id. Unlinked resolves which person it is.
 */
export type UnlinkedTarget = { by: 'profileId' | 'connectionId' | 'linkedinUrl'; value: string };
export function cleanUnlinkedTarget(value: unknown): UnlinkedTarget {
  if (typeof value === 'string' && value.trim().length <= 512 && /^(https?:\/\/)?([a-z]+\.)?linkedin\.com\/in\//i.test(value.trim())) return { by: 'linkedinUrl', value: value.trim() };
  const id = cleanUnlinkedProfileId(value);
  return /^[a-f0-9]{64}$/.test(id) ? { by: 'connectionId', value: id } : { by: 'profileId', value: id };
}

export function parseLinkTarget(value: unknown): LinkTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(400, 'Choose what to link to');
  const input = value as Record<string, unknown>;
  if (input.kind === 'user') {
    if (typeof input.id !== 'string' || !input.id || input.id.length > 200) return fail(400, 'Choose a person');
    return { kind: 'user', id: input.id };
  }
  if (input.kind === 'unlinked') return { kind: 'unlinked', id: cleanUnlinkedTarget(input.id).value };
  if (!THING_KINDS.includes(input.kind as ThingKind)) return fail(400, KIND_CHOICE);
  if (typeof input.id === 'string' && input.id) {
    if (input.id.length > 64) return fail(400, 'Unknown item');
    return { kind: input.kind as ThingKind, id: input.id };
  }
  const name = cleanText(input.name, LIMITS.nameLength, 'Name');
  if (input.createNew === undefined || input.createNew === false) return { kind: input.kind as ThingKind, name };
  // A deliberately separate entity with a name the owner already uses. The
  // request id makes a retry find the same entity instead of a third one.
  if (input.createNew !== true) return fail(400, 'createNew must be true or false');
  if (typeof input.clientRequestId !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(input.clientRequestId)) return fail(400, 'createNew needs a clientRequestId to keep retries from duplicating');
  return { kind: input.kind as ThingKind, name, createNew: { requestId: input.clientRequestId } };
}


type Runner = { run: (query: string, parameters?: Record<string, unknown>) => Promise<{ records: Array<{ get: (key: string) => unknown }> }> };

// ---- the overlay store, and how OpenChat names owners and people in it ----

let overlay: OverlayStore | null = null;
let overlayReady: Promise<void> | null = null;
const ownerWrites = new AsyncLocalStorage<{ ownerId: string; ownerKey: string }>();
function ownerFencedDriver(driver: Driver): Driver {
  return new Proxy(driver, { get(target, key) {
    if (key === 'session') return (...args: Parameters<Driver['session']>) => {
      const session = target.session(...args);
      return new Proxy(session, { get(target, key) {
        if (key === 'executeWrite') {
          const executeWrite: typeof session.executeWrite = (work, config) => session.executeWrite(async tx => {
            const owner = ownerWrites.getStore();
            if (owner) await assertPrivateGraphOwnerIn(tx, owner.ownerId, owner.ownerKey);
            return work(tx);
          }, config);
          return executeWrite;
        }
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
async function store(): Promise<OverlayStore> {
  overlay ??= new OverlayStore(ownerFencedDriver(getDriver()), process.env.NEO4J_DATABASE || 'neo4j');
  overlayReady ??= overlay.initialize().catch(error => { overlayReady = null; throw error; });
  await overlayReady;
  return overlay;
}

const MESSAGES: Record<string, string> = {
  not_found: 'Not found', note_limit: 'This card has reached its note limit', link_limit: 'You have reached the limit for links',
  entity_limit: 'You have reached the limit for saved items', self_link: 'Choose something else to link to',
  kind_conflict: 'That item is a different kind', name_conflict: 'You already have something with that name',
  invalid_provenance: 'Unknown author, source or assertion', invalid_relation_type: `relationType must be one of ${RELATION_TYPES.join(', ')}`,
  invalid_query: 'Give a search text, a relation type or a kind', invalid_depth: 'depth must be 1 or 2',
  invalid_request_id: 'createNew needs a clientRequestId to keep retries from duplicating', invalid_create_new: 'createNew must be true or false',
  invalid_relation: 'Relation is required (60 characters or fewer)', invalid_note: 'Note is required (4000 characters or fewer)',
  invalid_kind: KIND_CHOICE, kind_fixed: 'This item is someone on OpenChat or Unlinked; its kind stays as it is',
  invalid_description: 'Description must be one line of 280 characters or fewer', invalid_since: 'since must be 20 characters or fewer, for example 2019 or 2024-03',
  invalid_until: 'until must be 20 characters or fewer, for example 2021', invalid_context: 'context must be 280 characters or fewer',
  invalid_link: 'Unknown link field', nothing_to_change: 'Nothing to change',
  invalid_ask: 'An ask needs its text (1000 characters or fewer) and only known fields',
  invalid_author: 'Choose who cares about it: yourself, an OpenChat person, an Unlinked person, or a saved person, company, project or idea',
  invalid_asker: 'Choose who cares about it: yourself, an OpenChat person, an Unlinked person, or a saved person, company, project or idea',
  invalid_carrier: 'Choose who carries it: yourself, an OpenChat person, an Unlinked person, or a saved person or company',
  invalid_placement: 'Place it on your own stream, a person, a saved company, project or idea, or a conversation you are in (8 at most)',
  invalid_direction: 'direction must be from_me, for_me or from_others', author_fixed: 'Who cares about an ask stays as it is; save a new ask instead',
  invalid_horizon: `horizon must be one of ${ASK_HORIZONS.join(', ')}`, invalid_status: `status must be one of ${ASK_STATUSES.join(', ')}`,
  invalid_exposure: `exposure must be one of ${ASK_EXPOSURES.join(', ')}; this_chat needs exposureConversationId`, invalid_recheck_after: 'recheckAfter must be a date such as 2026-12-29',
  invalid_evidence: 'evidence takes quote, url (http or https), label, seenAt and noteId (one of your private notes)', duplicate_ask: 'That person already has an ask with this text',
  ask_limit: 'You have reached the limit for asks', ask_fields: 'Edit or delete an ask (and who asks it) through the ask tools',
  has_asks: 'This one has asks; a topic cannot ask, so its kind stays as it is',
  state_conflict: 'People state has changed. Read the current revision and try again.',
  operation_id_reused: 'This operation id was already used for a different request.',
  legacy_operation_requires_reconciliation: 'This earlier operation needs reconciliation before retrying.',
  merged_record: 'This record is part of a merged person. Split it off first, then delete it.',
  merged_person: 'This person has merged records. Split them off first, then delete.',
  merge_kind: 'Only people can be merged', merge_account: 'OpenChat people keep their own card and cannot be merged yet',
  merge_state_conflict: 'More than one of these has People state or a catch-up setting; merge them by hand',
  cannot_link: 'These were marked as different people', merge_too_large: 'That would make a person of more than 50 records',
  merge_superseded: 'A later merge or split depends on this one; undo that first', not_merged: 'This record is not merged with anything',
  revert_kind: 'Only merges can be undone; merge again to undo a split', invalid_merge: 'Give 2 to 50 thing ids, a rule and an operationId',
  invalid_head: 'headId must be one of the ids', invalid_split: 'Give the thing id to split off and an operationId', invalid_revert: 'Give either an eventId or a batchId',
  invalid_merge_batch: 'Give 1 to 25 merges', revert_too_large: 'That batch has more than 1000 merges', invalid_batch: 'Unknown batch id', invalid_entity: 'Unknown thing id',
  stale_revision: 'This note was changed elsewhere. Choose which version to keep.', invalid_revision: 'ifRevision must be a positive whole number',
  invalid_field: 'A field needs a kind, a value and a clientRequestId, and only known keys', invalid_field_kind: 'kind must be address, phone, email, wifi, birthday, social, context or custom',
  invalid_field_value: 'That value does not fit this kind (Wi-Fi takes {ssid, password})', invalid_field_label: 'label must be 60 characters or fewer',
  invalid_field_source: 'source must be owner, agent:<name>, note, imessage or an import source', invalid_observed_at: 'observedAt must be a date such as 2026-11-13',
  invalid_field_evidence: 'evidence takes noteId (one of this person\'s notes), quote, messageDate and sourceId', invalid_field_mark: 'Give an action and a value key (or operationId to undo, suggestionId to dismiss, assertionId to retract) and a clientRequestId',
  field_not_found: 'No such value on this person', suggestion_not_found: 'That suggestion is no longer there', operation_not_found: 'No such field change on this person',
  fields_people_only: 'Only people have contact fields',
  invalid_decision: 'Give 2 to 50 thing ids and an operationId', already_same_person: 'Some of these are already one person; split them first',
};
/** Overlay refusals become the app's own wording; anything else stays an unexpected error. */
async function overlayCall<T>(work: (overlay: OverlayStore) => Promise<T>): Promise<T> {
  try { return await work(await store()); }
  catch (error) {
    if (error instanceof OverlayError && error.code === 'ambiguous_name') fail(409, String(error.details?.message ?? 'More than one saved item has that name. Choose one by id, or set createNew with a clientRequestId for a different one.'), { code: 'ambiguous_name', candidates: candidatesFor(error.details?.candidates) });
    if (error instanceof OverlayError && error.status < 500) {
      const details: Record<string, unknown> = { code: error.code };
      if (Number.isSafeInteger(error.details?.revision) && Number(error.details?.revision) >= 0) details.revision = error.details!.revision;
      if (typeof error.details?.askId === 'string') details.askId = error.details.askId;
      fail(error.status, MESSAGES[error.code] ?? 'Check what you entered and try again', details);
    }
    throw error;
  }
}

function ownerWrite<T>(ownerId: string, principal: OverlayPrincipal, work: (overlay: OverlayStore) => Promise<T>): Promise<T> {
  return ownerWrites.run({ ownerId, ownerKey: principal.ownerKey }, () => overlayCall(work));
}

/** The overlay's candidates for an ambiguous name, as the app names them, with the arguments that pick each one. */
function candidatesFor(raw: unknown): Array<LinkEnd & { use: { toKind: string; toId: string } }> {
  return (Array.isArray(raw) ? raw as Candidate[] : []).map(candidate => {
    const end = endOf(candidate);
    return { ...end, use: end.kind === 'user' ? { toKind: 'user', toId: end.id } : end.unlinkedProfileId ? { toKind: 'unlinked', toId: end.unlinkedProfileId } : { toKind: candidate.kind, toId: end.id } };
  });
}

/**
 * An owner is named by their Ideaflow sign-in when they have one, so the same
 * person owns the same overlay from any Ideaflow app. Accounts without one are
 * named by their OpenChat id until they link it.
 */
const OPENCHAT_ISSUER = 'https://chat.ideaflow.app/openchat-user';
const fallbackKey = (userId: string) => ownerKeyFor(OPENCHAT_ISSUER, userId);
const rekeyed = new Set<string>();
async function principalFor(ownerId: string, issuer: unknown, subject: unknown): Promise<OverlayPrincipal> {
  if (typeof issuer !== 'string' || !issuer || typeof subject !== 'string' || !subject) return { app: 'openchat', ownerKey: fallbackKey(ownerId) };
  const ownerKey = ownerKeyFor(issuer, subject);
  // What they wrote before linking their sign-in follows them, once per process.
  if (!rekeyed.has(ownerId)) {
    try { await (await store()).rekeyOwner(fallbackKey(ownerId), ownerKey);
      {
        const db = getDriver().session();
        try { for (const label of ['OpenChatNoteReview', 'OpenChatPrivateAsk']) await db.run(`MATCH (n:${label} {ownerKey:$fromKey}) SET n.ownerKey=$ownerKey`, { fromKey: fallbackKey(ownerId), ownerKey }); }
        finally { await db.close(); }
      }
      rekeyed.add(ownerId); }
    catch (error) {
      if (!(error instanceof OverlayError) || error.code !== 'owner_conflict') throw error;
      // Both identities already hold an overlay; joining them is a deliberate act, not done here.
      console.warn('Private graph: an overlay under the OpenChat identity was left in place because the Ideaflow identity already has one');
      rekeyed.add(ownerId);
    }
  }
  return { app: 'openchat', ownerKey };
}

async function ownerContext(ownerId: string): Promise<{ principal: OverlayPrincipal; identity: { issuer: string; subject: string } | null }> {
  const session = getDriver().session();
  try {
    const result = await session.run('MATCH (owner:User {id: $ownerId}) RETURN owner.ideaflowIssuer AS issuer, owner.ideaflowSub AS subject', { ownerId });
    const record = result.records[0];
    if (!record) return fail(404, 'Not found');
    const issuer = record.get('issuer'), subject = record.get('subject');
    const identity = typeof issuer === 'string' && issuer && typeof subject === 'string' && subject ? { issuer, subject } : null;
    return { principal: await principalFor(ownerId, issuer, subject), identity };
  } finally { await session.close(); }
}
async function ownerPrincipal(ownerId: string): Promise<OverlayPrincipal> {
  return (await ownerContext(ownerId)).principal;
}

/** A user id as the value of an overlay ref; anything outside the ref alphabet is percent-encoded. */
const refValue = (id: string) => Array.from(Buffer.from(id, 'utf8')).map(byte => {
  const char = String.fromCharCode(byte);
  return /[A-Za-z0-9._@+-]/.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
}).join('');
const USER_REF = 'openchat:user:';
const userRef = (userId: string) => `${USER_REF}${refValue(userId)}`;
const userIdOf = (refs: string[]): string | null => {
  const ref = refs.find(value => value.startsWith(USER_REF));
  return ref ? decodeURIComponent(ref.slice(USER_REF.length)) : null;
};
/** The ref Unlinked uses for a person (docs/PEOPLE_OVERLAY.md in Noos), so both apps name the same entity. */
const UNLINKED_REF = 'unlinked:person:';
const unlinkedRef = (profileId: string) => `${UNLINKED_REF}${refValue(profileId)}`;
const unlinkedIdOf = (refs: string[]): string | null => {
  const ref = refs.find(value => value.startsWith(UNLINKED_REF));
  return ref ? decodeURIComponent(ref.slice(UNLINKED_REF.length)) : null;
};
/**
 * An imported LinkedIn contact is named by `linkedin:in:<sha256 of the
 * canonical slug>` (Noos docs/PEOPLE_OVERLAY.md), never by Unlinked's
 * connection id (it changes on re-import) or a plaintext address. The
 * connection id is asked of Unlinked when a read shows the contact.
 */
async function ownerIdentity(ownerId: string): Promise<{ issuer: string; subject: string } | null> {
  const session = getDriver().session();
  try {
    const record = (await session.run('MATCH (owner:User {id: $ownerId}) RETURN owner.ideaflowIssuer AS issuer, owner.ideaflowSub AS subject', { ownerId })).records[0];
    const issuer = record?.get('issuer'), subject = record?.get('subject');
    return typeof issuer === 'string' && issuer && typeof subject === 'string' && subject ? { issuer, subject } : null;
  } finally { await session.close(); }
}
/** Owner connection ids for the imported contacts among these ends, in one Unlinked call; known ones are not asked again. Empty when Unlinked cannot answer. */
type Connections = Map<string, string>;
async function connectionsFor(ownerId: string, ends: Array<{ refs: string[] }>, known: Connections = new Map()): Promise<Connections> {
  const hashes = [...new Set(ends.map(end => linkedinHashOf(end.refs)).filter((hash): hash is string => hash !== null && !known.has(hash)))];
  if (!hashes.length) return known;
  const result = await lookupUnlinkedContactsByHash(await ownerIdentity(ownerId), hashes);
  const connections = new Map(known);
  if (result.ok) for (const contact of result.contacts) if (contact.linkedinRefHash && contact.connectionId) connections.set(contact.linkedinRefHash, contact.connectionId);
  return connections;
}

/* A person the owner deliberately kept apart from a same-named one (createNew) is
   named by the overlay's own separate ref, `openchat:private:<hash>`; never an account. */

const displayName = `CASE WHEN subject.name IS NULL OR trim(subject.name) = '' OR subject.name CONTAINS '@' THEN $fallbackName ELSE subject.name END`;

/** The other person must exist, be a person, and have no block in either direction. */
async function assertPerson(ownerId: string, userId: string): Promise<{ person: PersonBasics; principal: OverlayPrincipal; name: string }> {
  if (ownerId === userId) fail(400, 'This card is for other people');
  if (typeof userId !== 'string' || !userId || userId.length > 200) fail(404, 'Person unavailable');
  const session = getDriver().session();
  try {
    const record = await personRecordIn(session, ownerId, userId);
    return {
      person: { id: userId, name: String(record.get('name')), avatarUrl: (record.get('avatarUrl') as string | null) ?? null },
      principal: await principalFor(ownerId, record.get('issuer'), record.get('subjectId')),
      name: String(record.get('shownName')),
    };
  } finally { await session.close(); }
}

async function personRecordIn(tx: Runner, ownerId: string, userId: string) {
  const result = await tx.run(`
    MATCH (owner:User {id: $ownerId}), (subject:User {id: $userId})
    RETURN coalesce(subject.isBot, false) AS isBot,
      ((owner)-[:BLOCKED]->(subject) OR (subject)-[:BLOCKED]->(owner)) AS blocked,
      coalesce(subject.name, 'Unknown') AS name, subject.avatarUrl AS avatarUrl, ${displayName} AS shownName,
      owner.ideaflowIssuer AS issuer, owner.ideaflowSub AS subjectId
  `, { ownerId, userId, fallbackName: DEFAULT_PUBLIC_DISPLAY_NAME });
  const record = result.records[0];
  if (!record || record.get('isBot') === true || record.get('blocked') === true) return fail(404, 'Person unavailable');
  return record;
}

async function lockPrivateGraphAccountsIn(tx: Runner, userIds: string[]): Promise<Set<string>> {
  const present = new Set<string>();
  for (const userId of [...new Set(userIds)].sort()) {
    await tx.run('MATCH (u:User {id:$userId}) SET u._privateGraphLock=true REMOVE u._privateGraphLock', { userId });
    const live = await tx.run('MATCH (u:User {id:$userId}) RETURN u.id AS id', { userId });
    if (live.records.length) present.add(userId);
  }
  return present;
}

async function assertPrivateGraphOwnerIn(tx: Runner, ownerId: string, ownerKey: string): Promise<void> {
  const present = await lockPrivateGraphAccountsIn(tx, [ownerId]);
  if (!present.has(ownerId)) return fail(404, 'Contact owner unavailable', { code: 'contact_owner_unavailable' });
  const result = await tx.run('MATCH (u:User {id:$ownerId}) RETURN u.ideaflowIssuer AS issuer,u.ideaflowSub AS subject', { ownerId });
  const issuer = result.records[0]?.get('issuer'), subject = result.records[0]?.get('subject');
  const currentKey = typeof issuer === 'string' && issuer && typeof subject === 'string' && subject ? ownerKeyFor(issuer, subject) : fallbackKey(ownerId);
  if (currentKey !== ownerKey) return fail(409, 'Contact owner identity changed; retry with the current account', { code: 'contact_owner_changed' });
}

/** The overlay entity for an OpenChat person, created on first write. */
async function personEntity(ownerId: string, userId: string): Promise<{ principal: OverlayPrincipal; entityId: string; person: PersonBasics }> {
  const { principal } = await assertPerson(ownerId, userId);
  return overlayCall(async () => {
    const db = getDriver().session({ database: process.env.NEO4J_DATABASE || 'neo4j' });
    try {
      return await db.executeWrite(async tx => {
        const present = await lockPrivateGraphAccountsIn(tx, [ownerId, userId]);
        if (!present.has(ownerId) || !present.has(userId)) return fail(404, 'Person unavailable');
        await assertPrivateGraphOwnerIn(tx, ownerId, principal.ownerKey);
        const record = await personRecordIn(tx, ownerId, userId);
        const { entity } = await ensureIn(tx, principal.ownerKey, { kind: 'person', name: cleanName(record.get('shownName')), ref: cleanRef(userRef(userId)) });
        return { principal, entityId: entity.id, person: { id: userId, name: String(record.get('name')), avatarUrl: (record.get('avatarUrl') as string | null) ?? null } };
      });
    } finally { await db.close(); }
  });
}

/** Link ends as the app knows them: an OpenChat person by user id and current name, anything else by entity id. */
async function linksFor(ownerId: string, links: OverlayLink[], known?: Connections): Promise<PrivateLink[]> {
  const names = await userNames(links.map(link => link.other));
  const connections = await connectionsFor(ownerId, links.map(link => link.other), known);
  return links.map(link => ({ ...provenanceOf(link), ...factsOf(link), id: link.id, relation: link.relation, relationType: link.relationType, direction: link.direction, other: endOf(link.other, names, connections), createdAt: link.createdAt, updatedAt: link.updatedAt }));
}
const provenanceOf = (value: Provenance): Provenance => ({ author: value.author, source: value.source, assertion: value.assertion });
const factsOf = (value: Partial<LinkFacts>): LinkFacts => ({ since: value.since ?? null, until: value.until ?? null, context: value.context ?? null, updatedBy: value.updatedBy ?? null });
function noteOf(note: PrivateNote): PrivateNote {
  return { id: note.id, text: note.text, createdAt: note.createdAt, updatedAt: note.updatedAt, ...provenanceOf(note), ...(note.revision ? { revision: note.revision } : {}), ...(note.editedBy ? { editedBy: note.editedBy } : {}) };
}
/** Current display names for the OpenChat people among these ends. */
async function userNames(ends: Array<{ refs: string[] }>): Promise<Map<string, string>> {
  const userIds = [...new Set(ends.map(end => userIdOf(end.refs)).filter((id): id is string => id !== null))];
  const names = new Map<string, string>();
  if (!userIds.length) return names;
  const session = getDriver().session();
  try {
    const result = await session.run(`MATCH (subject:User) WHERE subject.id IN $userIds RETURN subject.id AS id, ${displayName} AS name`, { userIds, fallbackName: DEFAULT_PUBLIC_DISPLAY_NAME });
    for (const record of result.records) names.set(String(record.get('id')), String(record.get('name')));
  } finally { await session.close(); }
  return names;
}
function endOf(entity: { id: string; kind: Entity['kind']; name: string; refs: string[]; description?: string | null }, names: Map<string, string> = new Map(), connections: Connections = new Map()): LinkEnd {
  const userId = userIdOf(entity.refs), description = entity.description ? { description: entity.description } : {};
  if (userId !== null) return { kind: 'user', id: userId, name: names.get(userId) ?? entity.name, ...description };
  return { kind: entity.kind, id: entity.id, name: entity.name, ...description, ...unlinkedFields(entity.refs, connections) };
}
/** The Unlinked names of an entity: its published profile, its imported contact's ref hash and, when known, connection id. */
function unlinkedFields(refs: string[], connections: Connections): { unlinkedProfileId?: string; linkedinRefHash?: string; unlinkedConnectionId?: string } {
  const unlinkedProfileId = unlinkedIdOf(refs), linkedinRefHash = linkedinHashOf(refs);
  const unlinkedConnectionId = linkedinRefHash ? connections.get(linkedinRefHash) : undefined;
  return { ...(unlinkedProfileId !== null ? { unlinkedProfileId } : {}), ...(linkedinRefHash ? { linkedinRefHash } : {}), ...(unlinkedConnectionId ? { unlinkedConnectionId } : {}) };
}

/** Unlinked's refusals as this app words them. */
function unlinkedFailure(code: string, target: UnlinkedTarget): never {
  if (code === 'not_found') return fail(404, target.by === 'profileId' ? 'No published Unlinked profile has that id' : target.by === 'connectionId' ? 'None of your Unlinked connections has that id' : 'Neither your Unlinked contacts nor a published profile have that LinkedIn address');
  if (code === 'not_linked') return fail(409, 'Sign in to Unlinked once with the same Ideaflow account to use Unlinked people here');
  if (code === 'grant_revoked' || code === 'scope_not_granted') return fail(409, 'Unlinked agent access is off for this account; turn it on in Unlinked Settings');
  return fail(503, 'Unlinked could not confirm that person right now; retry');
}
/** The overlay refs for an Unlinked person: the published profile and the imported contact, whichever exist. */
function unlinkedRefs(contact: UnlinkedContact): string[] {
  return [...(contact.publishedProfileId ? [unlinkedRef(contact.publishedProfileId)] : []), ...(contact.linkedinRefHash ? [linkedinRef(contact.linkedinRefHash)] : [])];
}

/**
 * The entity for an Unlinked person: a published profile id, one of the
 * owner's imported contacts (connection id from unlinked_list_connections), or
 * a LinkedIn address. An existing published-profile ref answers without asking
 * Unlinked (it was confirmed when first written). Anything new is confirmed
 * with the owner's own read-only Unlinked grant, which only ever answers the
 * owner's own imports and published profiles. A published person is
 * `unlinked:person:<id>`, an imported contact `linkedin:in:<hash>`; when both
 * apply the one entity carries both refs (the overlay's ensureRefs), so the
 * contact stays one person after they publish. People saved by name are never
 * joined to it by name.
 */
async function unlinkedPersonEntity(ownerId: string, raw: string): Promise<{ principal: OverlayPrincipal; entityId: string; contact?: UnlinkedContact }> {
  const target = cleanUnlinkedTarget(raw);
  const { principal, identity } = await ownerContext(ownerId);
  if (target.by === 'profileId') {
    const known = await overlayCall(overlay => overlay.lookup(principal, unlinkedRef(target.value)));
    if (known) return { principal, entityId: known.id };
  }
  const result = await lookupUnlinkedContactForIdentity(identity, target.by === 'profileId' ? { profileId: target.value } : target.by === 'connectionId' ? { connectionId: target.value } : { linkedinUrl: target.value });
  if (!result.ok) return unlinkedFailure(result.code, target);
  const refs = unlinkedRefs(result.contact);
  if (!refs.length) return fail(409, 'That contact has no LinkedIn address or published Unlinked profile to keep a card by; save them by name instead');
  const name = result.contact.name.trim() || 'LinkedIn contact';
  const { entity } = await overlayCall(overlay => overlay.ensureRefs(principal, { kind: 'person', name, refs }));
  return { principal, entityId: entity.id, contact: result.contact };
}

/** The owner's existing entity for an Unlinked person, without writing anything. Published ids never ask Unlinked. */
async function findUnlinkedEntity(ownerId: string, principal: OverlayPrincipal, raw: unknown): Promise<{ target: UnlinkedTarget; found: EntityDetail | null; contact: UnlinkedContact | null }> {
  const target = cleanUnlinkedTarget(raw);
  if (target.by === 'profileId') return { target, found: await overlayCall(overlay => overlay.lookup(principal, unlinkedRef(target.value))), contact: null };
  const result = await lookupUnlinkedContactForIdentity(await ownerIdentity(ownerId), target.by === 'connectionId' ? { connectionId: target.value } : { linkedinUrl: target.value });
  if (!result.ok) {
    if (result.code === 'not_found') return { target, found: null, contact: null };
    return unlinkedFailure(result.code, target);
  }
  for (const ref of unlinkedRefs(result.contact)) {
    const found = await overlayCall(overlay => overlay.lookup(principal, ref));
    if (found) return { target, found, contact: result.contact };
  }
  return { target, found: null, contact: result.contact };
}

/**
 * A saved thing named in a link. The overlay decides (Noos owns the rule): a
 * name is reused only when it names exactly one of the owner's saved things
 * of that kind and that one has no ref; two people called Alex are never
 * merged by name. Otherwise the caller gets the candidates and picks one by
 * id, or asks for a separate new entity (createNew + clientRequestId).
 */
async function namedEntity(principal: OverlayPrincipal, target: { kind: ThingKind; name: string; createNew?: { requestId: string } }, description?: unknown): Promise<string> {
  try {
    return (await overlayCall(overlay => overlay.resolve(principal, { kind: target.kind, name: target.name, description, ...(target.createNew ? { createNew: true, clientRequestId: target.createNew.requestId } : {}) }))).entity.id;
  } catch (error) {
    if (error instanceof PrivateGraphError && error.details?.code === 'ambiguous_name') fail(409, `More than one ${target.kind} is called ${target.name}. Choose one by id, or set createNew with a clientRequestId for a different one.`, error.details);
    throw error;
  }
}

/** The entity a note or link starts from. */
async function subjectEntity(ownerId: string, subject: Subject): Promise<{ principal: OverlayPrincipal; entityId: string; contact?: UnlinkedContact }> {
  if (subject.kind === 'user') return personEntity(ownerId, subject.id);
  if (subject.kind === 'unlinked') return unlinkedPersonEntity(ownerId, subject.id);
  return { principal: await ownerPrincipal(ownerId), entityId: subject.id };
}

// ---- what the routes call ----

export async function getPersonOverlay(ownerId: string, userId: string): Promise<PersonOverlay> {
  // Reading never creates anything: a person nobody has written about has an empty card.
  const { person, principal } = await assertPerson(ownerId, userId);
  const found = await overlayCall(overlay => overlay.lookup(principal, userRef(userId)));
  return { userId, person, card: found?.card ?? { ...EMPTY_CARD }, notes: (found?.notes ?? []).map(noteOf), links: await linksFor(ownerId, found?.links ?? []) };
}

function contactPrincipal(principal: OverlayPrincipal, by: Provenance, actorId?: string): OverlayPrincipal {
  return {...principal, actor:by.author ?? 'owner', ...(actorId === undefined ? {} : {actorId})};
}

export async function updatePersonCard(ownerId: string, userId: string, patch: CardPatch, by: Provenance = OWNER_PROVENANCE, actorId?: string): Promise<PersonCard> {
  const { principal, entityId } = await personEntity(ownerId, userId);
  return (await ownerWrite(ownerId, principal, overlay => overlay.update(contactPrincipal(principal,by,actorId), entityId, { card: patch }, by))).card;
}

/** The same text already on this card is the same note (the overlay dedupes): a retried request never doubles it. */
export async function addNote(ownerId: string, subject: Subject, rawText: unknown, by: Provenance = OWNER_PROVENANCE): Promise<PrivateNote> {
  const text = cleanText(rawText, LIMITS.noteLength, 'Note');
  const { principal, entityId } = await subjectEntity(ownerId, subject);
  return noteOf((await overlayCall(overlay => overlay.addNote(principal, entityId, text, by))).note);
}

/** Edits a note in place; the replaced text is kept as a revision. `ifRevision` refuses an edit based on an older text (409, with the current note). */
export async function updateNote(ownerId: string, noteId: string, rawText: unknown, ifRevision?: unknown, by: Provenance = OWNER_PROVENANCE, actorId?: string): Promise<PrivateNote> {
  const text = cleanText(rawText, LIMITS.noteLength, 'Note');
  const principal = await ownerPrincipal(ownerId);
  try {
    return noteOf(await ownerWrite(ownerId, principal, overlay => overlay.updateNote(contactPrincipal(principal, by, actorId), noteId, text, { ifRevision, provenance: by })));
  } catch (error) {
    if (error instanceof PrivateGraphError && error.details?.code === 'stale_revision') {
      const current = await overlayCall(overlay => overlay.listNoteRevisions(principal, noteId)).catch(() => null);
      fail(409, MESSAGES.stale_revision!, { code: 'stale_revision', ...(current ? { note: noteOf(current.note) } : {}) });
    }
    throw error;
  }
}

export async function listNoteRevisions(ownerId: string, noteId: string) {
  const principal = await ownerPrincipal(ownerId);
  const found = await overlayCall(overlay => overlay.listNoteRevisions(principal, noteId));
  return { note: noteOf(found.note), revisions: found.revisions };
}

// Person fields (Noos docs/PEOPLE_OVERLAY.md, "Person fields"): append-only assertions and owner decisions.
export async function personFields(ownerId: string, thingId: string) {
  const principal = await ownerPrincipal(ownerId);
  return overlayCall(overlay => overlay.personFields(principal, thingId));
}
export async function setPersonField(ownerId: string, thingId: string, input: unknown, by: Provenance, actorId?: string) {
  const principal = await ownerPrincipal(ownerId);
  return ownerWrite(ownerId, principal, overlay => overlay.setPersonField(contactPrincipal(principal, by, actorId), thingId, input, by));
}
export async function markPersonField(ownerId: string, thingId: string, input: unknown, by: Provenance, actorId?: string) {
  const principal = await ownerPrincipal(ownerId);
  return ownerWrite(ownerId, principal, overlay => overlay.markPersonField(contactPrincipal(principal, by, actorId), thingId, input, by));
}
/** The one explicit read of an unmasked value (a Wi-Fi password). */
export async function revealPersonField(ownerId: string, thingId: string, key: string) {
  const principal = await ownerPrincipal(ownerId);
  return overlayCall(overlay => overlay.revealPersonField(principal, thingId, key));
}

export async function deleteNote(ownerId: string, noteId: string): Promise<{ deleted: true }> {
  const principal = await ownerPrincipal(ownerId);
  const db = getDriver().session();
  try {
    await db.executeWrite(async tx => {
      const reviews = await tx.run('MATCH (r:OpenChatNoteReview {ownerKey:$ownerKey}) RETURN r.id AS id,r.payload AS payload ORDER BY r.id', { ownerKey: principal.ownerKey });
      for (const row of reviews.records) {
        const payload = JSON.parse(String(row.get('payload'))) as { note: { id: string; text: string }; suggestions: Array<{evidence: string}>; sourceNoteAvailable?: boolean };
        if (payload.note.id !== noteId) continue;
        const locked = await tx.run('MATCH (r:OpenChatNoteReview {id:$id,ownerKey:$ownerKey}) SET r._lock=true REMOVE r._lock RETURN r.payload AS payload', { id: row.get('id'), ownerKey: principal.ownerKey });
        const current = JSON.parse(String(locked.records[0]!.get('payload'))) as typeof payload;
        current.note.text = ''; current.sourceNoteAvailable = false;
        current.suggestions = [];
        await tx.run('MATCH (r:OpenChatNoteReview {id:$id,ownerKey:$ownerKey}) SET r.payload=$payload', { id: row.get('id'), ownerKey: principal.ownerKey, payload: JSON.stringify(current) });
      }
      await deleteNoteIn(tx, principal.ownerKey, noteId);
    });
  } catch (error) {
    if (error instanceof OverlayError && error.status < 500) fail(error.status, MESSAGES[error.code] ?? 'Not found');
    throw error;
  } finally { await db.close(); }
  return { deleted: true };
}

/** The optional facts a new link may carry; the overlay validates them. */
export interface LinkAttributes { relationType?: unknown; since?: unknown; until?: unknown; context?: unknown }
const givenAttributes = (input: LinkAttributes = {}) => Object.fromEntries((['relationType', 'since', 'until', 'context'] as const).filter(key => input[key] !== undefined).map(key => [key, input[key]]));

/**
 * Link a person, saved thing or Unlinked profile to another. The same subject,
 * relation and target is one link: repeating it returns the existing link
 * unchanged (edit it with updateLink). `attributes` may name the relationType
 * (otherwise derived from the words and what the link connects) and give
 * since, until and context.
 */
export async function addLink(ownerId: string, from: Subject, rawRelation: unknown, rawTarget: unknown, by: Provenance = OWNER_PROVENANCE, attributes: LinkAttributes = {}): Promise<PrivateLink> {
  const relation = cleanRelation(rawRelation), target = parseLinkTarget(rawTarget);
  const subject = await subjectEntity(ownerId, from), { principal, entityId: fromId } = subject;
  const known: Connections = new Map();
  const remember = (contact?: UnlinkedContact) => { if (contact?.linkedinRefHash && contact.connectionId) known.set(contact.linkedinRefHash, contact.connectionId); };
  remember(subject.contact);
  let toId: string;
  if (target.kind === 'user') toId = (await personEntity(ownerId, target.id)).entityId;
  else if (target.kind === 'unlinked') { const resolved = await unlinkedPersonEntity(ownerId, target.id); remember(resolved.contact); toId = resolved.entityId; }
  else if ('id' in target) {
    const existing = await overlayCall(overlay => overlay.get(principal, target.id));
    if (existing.kind !== target.kind) fail(400, 'That item is a different kind');
    toId = existing.id;
  } else toId = await namedEntity(principal, target);
  // A list's `contains` links are its members, and members are people: no other path may add anything else.
  if (relation === LIST_MEMBERSHIP && from.kind === 'thing') {
    const [subjectKind, targetKind] = await overlayCall(async overlay => [(await overlay.get(principal, fromId)).kind, (await overlay.get(principal, toId)).kind]);
    if (subjectKind === 'list' && targetKind !== 'person') fail(400, 'A list contains people: add an OpenChat person, an Unlinked person or a saved person');
  }
  const { link } = await overlayCall(overlay => overlay.addLink(principal, fromId, relation, toId, by, givenAttributes(attributes)));
  return (await linksFor(ownerId, [link], known))[0]!;
}

/** A link edit: any of these; null clears since, until or context, and relationType null derives the type again. */
export interface LinkEdit extends LinkAttributes { relation?: unknown; assertion?: unknown }
/**
 * Edit a link in place. A string is the new relation text (the original
 * form). Changing the relation ("sister of" to "cousin of") rewrites relation,
 * type and identity and records the editor's provenance; when the owner
 * already has the edited link, the two become one and the existing link is
 * returned with merged: true. Changing anything else (assertion,
 * relationType, since, until, context) keeps the original author and records
 * the editor as updatedBy.
 */
export async function updateLink(ownerId: string, linkId: string, change: unknown, by: Provenance = OWNER_PROVENANCE): Promise<{ link: PrivateLink; merged: boolean }> {
  let patch: Record<string, unknown>;
  if (typeof change === 'string' || change === undefined || change === null) patch = { relation: cleanRelation(change) };
  else if (typeof change !== 'object' || Array.isArray(change)) return fail(400, 'Nothing to change');
  else {
    const input = change as LinkEdit;
    patch = givenAttributes(input);
    if (input.relation !== undefined) patch.relation = cleanRelation(input.relation);
    if (input.assertion !== undefined) {
      if (input.assertion !== 'stated' && input.assertion !== 'inferred') return fail(400, 'assertion must be stated or inferred');
      patch.assertion = input.assertion;
    }
    if (!Object.keys(patch).length) return fail(400, 'Give a relation, relationType, assertion, since, until or context to change');
  }
  const principal = await ownerPrincipal(ownerId);
  const { link, merged } = await overlayCall(overlay => overlay.updateLink(principal, linkId, patch, by));
  return { link: (await linksFor(ownerId, [link]))[0]!, merged };
}

/**
 * Read the owner's private card for an Unlinked person: a published profile id
 * (never asks Unlinked), or an owner connection id / LinkedIn address (asks
 * Unlinked which contact it is, read-only). Never creates anything.
 */
export async function getUnlinkedPersonOverlay(ownerId: string, raw: string): Promise<UnlinkedPersonOverlay> {
  const principal = await ownerPrincipal(ownerId);
  const { target, found, contact } = await findUnlinkedEntity(ownerId, principal, raw);
  const refs = found?.refs ?? [];
  const connections = await connectionsFor(ownerId, [{ refs }, ...(found?.links ?? []).map(link => link.other)], contact?.linkedinRefHash && contact.connectionId ? new Map([[contact.linkedinRefHash, contact.connectionId]]) : new Map());
  const linkedinRefHash = linkedinHashOf(refs) ?? contact?.linkedinRefHash ?? null;
  return {
    profileId: unlinkedIdOf(refs) ?? contact?.publishedProfileId ?? (target.by === 'profileId' ? target.value : null),
    connectionId: (linkedinRefHash ? connections.get(linkedinRefHash) : undefined) ?? contact?.connectionId ?? null,
    linkedinRefHash,
    thingId: found?.id ?? null, name: found?.name ?? (contact?.name || null), card: found?.card ?? { ...EMPTY_CARD },
    notes: (found?.notes ?? []).map(noteOf), links: await linksFor(ownerId, found?.links ?? [], connections),
  };
}

/** Every private link the owner has recorded, newest first, optionally filtered by a name or relation. */
export async function listOwnerLinks(ownerId: string, rawQuery: unknown): Promise<{ links: OwnerLink[]; total: number }> {
  const query = typeof rawQuery === 'string' ? nameKey(rawQuery).slice(0, LIMITS.nameLength) : '';
  const principal = await ownerPrincipal(ownerId);
  const exported = await overlayCall(overlay => overlay.exportOwnerLinks(principal)) as { entities: Array<{ id: string; kind: ThingKind; name: string; description: string | null; refs: string[] }>; links: Array<Edge & { fromId: string; toId: string }> };
  const entities = new Map(exported.entities.map(entity => [entity.id, entity]));
  const names = await userNames(exported.entities);
  const linked = new Set(exported.links.flatMap(link => [link.fromId, link.toId]));
  const connections = await connectionsFor(ownerId, exported.entities.filter(entity => linked.has(entity.id)));
  const links = exported.links.flatMap(link => {
    const from = entities.get(link.fromId), to = entities.get(link.toId);
    return from && to ? [ownerLink(link, from, to, names, connections)] : [];
  }).filter(link => !query || [link.relation, link.from.name, link.to.name].some(value => nameKey(value).includes(query)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  return { links: links.slice(0, 200), total: links.length };
}
type End = { id: string; kind: Entity['kind']; name: string; refs: string[]; description?: string | null };
function ownerLink(link: Edge, from: End, to: End, names: Map<string, string>, connections: Connections = new Map()): OwnerLink {
  return {
    id: link.id, relation: link.relation, relationType: link.relationType, from: endOf(from, names, connections), to: endOf(to, names, connections), createdAt: link.createdAt,
    updatedAt: link.updatedAt ?? null, author: link.author ?? null, source: link.source ?? null, assertion: link.assertion ?? null, ...factsOf(link),
  };
}

/**
 * Search the owner's private knowledge: saved people, companies, ideas and
 * projects, OpenChat people and Unlinked people they wrote about (by name or
 * note text), and private relations by relation text, relation type or either
 * end's name. Read-only and owner-only; blocked people are left out.
 */
export async function searchPrivate(ownerId: string, input: { q?: unknown; relationType?: unknown; kind?: unknown; limit?: unknown }): Promise<PrivateSearch> {
  const principal = await ownerPrincipal(ownerId);
  const kind = input.kind === 'user' ? 'person' : input.kind;
  if (kind !== undefined && kind !== '' && kind !== 'ask' && !THING_KINDS.includes(kind as ThingKind)) fail(400, 'Unknown kind');
  const found = await overlayCall(overlay => overlay.search(principal, { q: input.q, relationType: input.relationType, kind, limit: input.limit }));
  const hidden = await blockedUserIds(ownerId, [...found.entities, ...found.links.flatMap(link => [link.from, link.to])]);
  const names = await userNames([...found.entities, ...found.links.flatMap(link => [link.from, link.to])]);
  const hiddenAsks = await hiddenAskIds(ownerId, principal, [...found.entities, ...found.links.flatMap(link => [link.from, link.to])]);
  const visible = (end: { id: string; refs: string[] }) => { const userId = userIdOf(end.refs); return (userId === null || !hidden.has(userId)) && !hiddenAsks.has(end.id); };
  const connections = await connectionsFor(ownerId, [...found.entities, ...found.links.flatMap(link => [link.from, link.to])].filter(visible));
  return {
    things: found.entities.filter(visible).map(entity => ({ ...endOf(entity, names, connections), matched: entity.matched.filter((value): value is 'name' | 'description' | 'note' => value !== 'link') })),
    links: found.links.filter(link => visible(link.from) && visible(link.to)).map(link => ownerLink(link, link.from, link.to, names, connections)),
    truncated: found.truncated,
  };
}

/**
 * One subject and what surrounds it: the people, companies, ideas and
 * projects one or two private relations away, and those relations. Never
 * creates anything: a subject nobody has written about has an empty
 * neighbourhood. Blocked people are left out.
 */
export async function getNeighbourhood(ownerId: string, subject: Subject, rawDepth: unknown): Promise<PrivateNeighbourhood> {
  const principal = await ownerPrincipal(ownerId);
  const depth = rawDepth === undefined || rawDepth === null || rawDepth === '' || String(rawDepth) === '1' ? 1 : String(rawDepth) === '2' ? 2 : fail(400, 'depth must be 1 or 2');
  let entityId: string | null;
  let fallback: LinkEnd;
  if (subject.kind === 'user') {
    const { person } = await assertPerson(ownerId, subject.id);
    entityId = (await overlayCall(overlay => overlay.lookup(principal, userRef(subject.id))))?.id ?? null;
    fallback = { kind: 'user', id: subject.id, name: person.name };
  } else if (subject.kind === 'unlinked') {
    const { target, found, contact } = await findUnlinkedEntity(ownerId, principal, subject.id);
    entityId = found?.id ?? null;
    fallback = { kind: 'person', id: '', name: contact?.name ?? '',
      ...(target.by === 'profileId' ? { unlinkedProfileId: target.value } : contact?.publishedProfileId ? { unlinkedProfileId: contact.publishedProfileId } : {}),
      ...(contact?.linkedinRefHash ? { linkedinRefHash: contact.linkedinRefHash } : {}), ...(contact?.connectionId ? { unlinkedConnectionId: contact.connectionId } : {}) };
  } else {
    entityId = subject.id;
    fallback = { kind: 'person', id: subject.id, name: '' };
  }
  if (!entityId) return { center: fallback, depth, nodes: [], links: [], truncated: false };
  const around = await overlayCall(overlay => overlay.neighbourhood(principal, entityId, depth));
  if (subject.kind === 'thing' && userIdOf(around.center.refs) !== null) fail(404, 'Not found');
  const all: Entity[] = [around.center, ...around.entities];
  const hidden = await blockedUserIds(ownerId, all);
  const names = await userNames(all);
  const hiddenAsks = await hiddenAskIds(ownerId, principal, all);
  const byId = new Map(all.map(entity => [entity.id, entity]));
  const visible = (entity: Entity | undefined): entity is Entity => { const userId = entity ? userIdOf(entity.refs) : null; return !!entity && (userId === null || !hidden.has(userId)) && !hiddenAsks.has(entity.id); };
  const connections = await connectionsFor(ownerId, all.filter(visible));
  return {
    center: endOf(around.center, names, connections), depth,
    nodes: around.entities.filter(visible).map(entity => endOf(entity, names, connections)),
    links: around.links.flatMap(link => {
      const from = byId.get(link.fromId), to = byId.get(link.toId);
      return visible(from) && visible(to) ? [ownerLink(link, from, to, names, connections)] : [];
    }),
    truncated: around.truncated,
  };
}

/** OpenChat people among these ends who are blocked in either direction, or gone. */
async function blockedUserIds(ownerId: string, ends: Array<{ refs: string[] }>): Promise<Set<string>> {
  const userIds = [...new Set(ends.map(end => userIdOf(end.refs)).filter((id): id is string => id !== null))];
  if (!userIds.length) return new Set();
  const session = getDriver().session();
  try {
    const result = await session.run(`MATCH (owner:User {id: $ownerId}) UNWIND $userIds AS userId
      OPTIONAL MATCH (subject:User {id: userId})
      WITH owner, userId, subject WHERE subject IS NULL OR (owner)-[:BLOCKED]->(subject) OR (subject)-[:BLOCKED]->(owner) OR coalesce(subject.isBot, false)
      RETURN collect(userId) AS hidden`, { ownerId, userIds });
    return new Set((result.records[0]?.get('hidden') as string[] | undefined) ?? []);
  } finally { await session.close(); }
}

export async function deleteLink(ownerId: string, linkId: string): Promise<{ deleted: true }> {
  const principal = await ownerPrincipal(ownerId);
  await overlayCall(overlay => overlay.deleteLink(principal, linkId));
  return { deleted: true };
}

/**
 * Delete (undo) a saved person, company, idea or project: the entity, its
 * notes, its links in both directions and its refs, plus OpenChat's own note
 * reviews and asks about it, in one transaction. An OpenChat person's card is
 * not a saved thing and answers 404, as does a missing or foreign id.
 */
export async function deletePrivateThing(ownerId: string, thingId: string): Promise<{ deleted: true; id: string; notesRemoved: number; linksRemoved: number }> {
  const principal = await ownerPrincipal(ownerId);
  await store();
  const ownerKey = principal.ownerKey;
  const db = getDriver().session();
  try {
    const removed = await db.executeWrite(async tx => {
      const found = await tx.run('MATCH (e:OverlayEntity {id: $thingId, ownerKey: $ownerKey}) RETURN [(r:OverlayRef)-[:REF_OF]->(e) | r.ref] AS refs', { thingId, ownerKey });
      const refs = found.records[0]?.get('refs') as string[] | undefined;
      if (!refs || userIdOf(refs) !== null) return fail(404, 'Not found');
      // A topic's card asks (the owner's own, captured on that card and linked to no other subject) go with it, as they did before asks moved into the overlay.
      const cardAsks = await tx.run(`MATCH (a:OverlayEntity {ownerKey: $ownerKey, kind: 'ask'})-[:OVERLAY_LINK {relation: 'is about'}]->(:OverlayEntity {id: $thingId, ownerKey: $ownerKey})
        WHERE coalesce(a.askAuthorSelf, a.askOwn, false) = true AND a.evidenceLabel IN $labels AND NOT EXISTS { MATCH (a)-[:OVERLAY_LINK {relation: 'is about'}]->(other:OverlayEntity) WHERE other.id <> $thingId }
        RETURN a.id AS id`, { ownerKey, thingId, labels: ['Private note review', 'Standing ask on a private card'] });
      const { result } = await eraseCanonicalEntitiesIn(tx, async runner => {
        for (const record of cardAsks.records) await deleteEntityIn(runner, ownerKey, String(record.get('id')));
        return deleteEntityIn(runner, ownerKey, thingId);
      });
      return result;
    });
    return { deleted: true, id: thingId, notesRemoved: removed.notesRemoved, linksRemoved: removed.linksRemoved };
  } catch (error) {
    if (error instanceof OverlayError && error.status < 500) fail(error.status, MESSAGES[error.code] ?? 'Check what you entered and try again');
    throw error;
  } finally { await db.close(); }
}

const thingOf = (entity: Entity): Thing => ({ id: entity.id, kind: entity.kind as ThingKind, name: entity.name, description: entity.description ?? null });

/** Save a private named subject; this never binds or creates an OpenChat account. A description fills a blank one. */
export async function createPrivateThing(ownerId: string, rawKind: unknown, rawName: unknown, description?: unknown): Promise<Thing> {
  if (!THING_KINDS.includes(rawKind as ThingKind)) fail(400, KIND_CHOICE);
  const name = cleanText(rawName, LIMITS.nameLength, 'Name');
  const principal = await ownerPrincipal(ownerId);
  const { entity } = await overlayCall(overlay => overlay.ensure(principal, { kind: rawKind, name, description }));
  return thingOf(entity);
}

/**
 * Edit a saved thing: rename it, change its one-line description (null or ''
 * clears it) or its kind (an idea that became a project). The kind of someone
 * on Unlinked stays as it is (409); an OpenChat person's card is not a saved
 * thing (404).
 */
export async function updatePrivateThing(ownerId: string, thingId: string, raw: unknown): Promise<Thing> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(400, 'Nothing to change');
  const { name, description, kind, ...rest } = raw as Record<string, unknown>;
  if (Object.keys(rest).length) return fail(400, 'Only name, description and kind can be changed');
  if (name === undefined && description === undefined && kind === undefined) return fail(400, 'Give a name, description or kind to change');
  if (kind !== undefined && !THING_KINDS.includes(kind as ThingKind)) return fail(400, KIND_CHOICE);
  const patch = { ...(name !== undefined ? { name: cleanText(name, LIMITS.nameLength, 'Name') } : {}), ...(description !== undefined ? { description } : {}), ...(kind !== undefined ? { kind } : {}) };
  const principal = await ownerPrincipal(ownerId);
  const found = await overlayCall(overlay => overlay.get(principal, thingId));
  if (userIdOf(found.refs) !== null) fail(404, 'Not found');
  // A list's members are its `contains` links: re-kinding either way would leave them meaning something else.
  if (kind !== undefined && kind !== found.kind && (kind === 'list' || found.kind === 'list')) fail(409, 'A list stays a list, and other saved things cannot become lists');
  return thingOf(await overlayCall(overlay => overlay.update(principal, thingId, patch)));
}

/**
 * Find or save a person, company, idea or project by name with the same rules
 * as a link target: a shared name is never merged (409 ambiguous_name with
 * candidates), and createNew with a clientRequestId saves a separate one
 * idempotently. Never binds or creates an account.
 */
export async function resolvePrivateThing(ownerId: string, raw: unknown): Promise<Thing> {
  const target = parseLinkTarget(raw);
  if (!('name' in target)) return fail(400, 'Give a kind and a name');
  const principal = await ownerPrincipal(ownerId);
  const entityId = await namedEntity(principal, target, (raw as { description?: unknown }).description);
  return thingOf(await overlayCall(overlay => overlay.get(principal, entityId)));
}

/** Saved companies, ideas, projects and people-by-name. People on OpenChat are reached through their profile instead. */
export async function listThings(ownerId: string, query: unknown, kind: unknown, options: { after?: unknown; limit?: unknown; details?: unknown; summary?: unknown } = {}) {
  if (kind !== undefined && !THING_KINDS.includes(kind as ThingKind)) fail(400, 'Unknown kind');
  const principal = await ownerPrincipal(ownerId);
  const summary = options.summary === true || options.summary === 'true';
  const includeDetails = !summary && (options.details === true || options.details === 'true');
  const page = await overlayCall(overlay => overlay.listPage(principal, {q:query, kind, after:options.after, limit:options.limit,
    excludeRefPrefix:'openchat:user:', namedOnly:true, details:includeDetails}));
  if (summary) return {things:page.entities.map(e => ({...thingOf(e), card:e.card, ...(e.members ? {members:e.members} : {})})), nextCursor:page.nextCursor, total:page.total};
  const details = page.entities as EntityDetail[];
  const connections = includeDetails
    ? await connectionsFor(ownerId, details.flatMap(e => [e, ...(e.links ?? []).map(l => l.other)])) : new Map();
  const things = await Promise.all(details.map(async e => ({...thingOf(e), card:e.card, ...((e as any).peopleState ? {peopleState:(e as any).peopleState} : {}), ...(e.members ? {members:e.members} : {}),
    ...(e.notes ? {notes:e.notes.map(noteOf), links:await linksFor(ownerId,e.links,connections), contactSources:e.contactSources ?? []} : {})})));
  return {things, nextCursor:page.nextCursor, total:page.total};
}

export async function importContactSource(ownerId:string, input:unknown, by:Provenance, actorId?:string) {
  const principal=await ownerPrincipal(ownerId);
  const result=await ownerWrite(ownerId,principal,overlay=>overlay.importContact(contactPrincipal(principal,by,actorId),input,by));
  return {...result, entity:thingOf(result.entity)};
}
export async function importContactSources(ownerId:string, cards:unknown, by:Provenance, actorId?:string) {
  const principal=await ownerPrincipal(ownerId);
  return ownerWrite(ownerId,principal,async overlay => {
    if (!Array.isArray(cards) || cards.length < 1 || cards.length > 25) throw new OverlayError(400,'invalid_contact_batch');
    const results: Array<Record<string,unknown>> = [];
    for (let index = 0; index < cards.length; index++) {
      try {
        const result = await overlay.importContact(contactPrincipal(principal,by,actorId),cards[index],by);
        results.push({index,id:result.entity.id,created:result.created,unchanged:result.unchanged});
      } catch (error) {
        if (error instanceof PrivateGraphError) return fail(error.status,error.message,{...error.details,index,results});
        results.push({index,error:error instanceof OverlayError && error.status < 500 ? error.code : 'contact_import_unavailable'});
      }
    }
    return {results};
  });
}
export async function savePeopleState(ownerId:string, thingId:string, input:unknown, by:Provenance, actorId?:string) {
  const principal=await ownerPrincipal(ownerId);
  return ownerWrite(ownerId,principal,overlay=>overlay.savePeopleState(contactPrincipal(principal,by,actorId),thingId,input,by));
}

/** Owner-authored private data remains readable independently of an account profile. A merged record reads as its person. */
export async function readContactState(ownerId:string, thingId:string) {
  const principal=await ownerPrincipal(ownerId);
  const found=await overlayCall(overlay=>overlay.get(principal,thingId));
  return {thingId:found.id, card:found.card, contactSources:found.contactSources ?? [], ...(found.peopleState ? {peopleState:found.peopleState} : {}),
    ...(found.requestedId ? {requestedId:found.requestedId} : {}), ...(found.members ? {members:found.members} : {})};
}

// People resolution (Noos docs/PEOPLE_OVERLAY.md, "Merging people"): identity-level writes, so they carry the verified actor like contact writes.
export async function mergePeople(ownerId:string, merges:unknown, batchId:unknown, by:Provenance, actorId?:string) {
  const principal=await ownerPrincipal(ownerId);
  if (!Array.isArray(merges)) return fail(400, MESSAGES.invalid_merge_batch!);
  const items=merges.map(item => item && typeof item === 'object' && !Array.isArray(item) && batchId !== undefined && (item as Record<string,unknown>).batchId === undefined ? {...item as Record<string,unknown>, batchId} : item);
  return ownerWrite(ownerId,principal,overlay=>overlay.mergePeopleBatch(contactPrincipal(principal,by,actorId),items,by));
}
export async function splitPerson(ownerId:string, input:unknown, by:Provenance, actorId?:string) {
  const principal=await ownerPrincipal(ownerId);
  return ownerWrite(ownerId,principal,overlay=>overlay.splitPerson(contactPrincipal(principal,by,actorId),input,by));
}
export async function revertMerge(ownerId:string, input:unknown, by:Provenance, actorId?:string) {
  const principal=await ownerPrincipal(ownerId);
  return ownerWrite(ownerId,principal,async overlay=>{
    try { return await overlay.revertMerge(contactPrincipal(principal,by,actorId),input,by); }
    catch (error) {
      if (error instanceof OverlayError && error.code === 'merge_superseded') fail(409, MESSAGES.merge_superseded!, {code:'merge_superseded', ...(error.details ?? {})});
      throw error;
    }
  });
}
/** Review screens: "different people" decisions (Noos docs/PEOPLE_OVERLAY.md, "Different people" decisions). */
export async function markDifferentPeople(ownerId:string, input:unknown, by:Provenance, actorId?:string) {
  const principal=await ownerPrincipal(ownerId);
  return ownerWrite(ownerId,principal,overlay=>overlay.markDifferentPeople(contactPrincipal(principal,by,actorId),input,by));
}
export async function undoDifferentPeople(ownerId:string, input:unknown, by:Provenance, actorId?:string) {
  const principal=await ownerPrincipal(ownerId);
  return ownerWrite(ownerId,principal,overlay=>overlay.undoDifferentPeople(contactPrincipal(principal,by,actorId),input,by));
}
export async function listIdentityDecisions(ownerId:string, ids:string[]) {
  const principal=await ownerPrincipal(ownerId);
  return overlayCall(overlay=>overlay.differentAmong(principal,ids));
}
export async function listMergeEvents(ownerId:string, filter:{batchId?:unknown; entityId?:unknown; limit?:unknown}) {
  const principal=await ownerPrincipal(ownerId);
  return overlayCall(overlay=>overlay.listMergeEvents(principal,filter));
}

export async function getThing(ownerId: string, thingId: string): Promise<ThingDetail> {
  const principal = await ownerPrincipal(ownerId);
  const found: EntityDetail = await overlayCall(overlay => overlay.get(principal, thingId));
  if (userIdOf(found.refs) !== null) fail(404, 'Not found');
  const connections = await connectionsFor(ownerId, [found, ...found.links.map(link => link.other)]);
  return { ...thingOf(found), card:found.card, peopleState:(found as any).peopleState, contactSources:found.contactSources ?? [], ...(found.fields ? {fields:found.fields, fieldSuggestions:found.fieldSuggestions ?? []} : {}), ...(found.members ? {members:found.members} : {}), ...(found.requestedId ? {requestedId:found.requestedId} : {}), ...unlinkedFields(found.refs, connections), notes: found.notes.map(noteOf), links: await linksFor(ownerId, found.links, connections) };
}

/** People whose catch-up date has passed, soonest first; starred people lead ties. */
export async function listDue(ownerId: string, now = new Date()): Promise<{ due: DuePerson[] }> {
  const principal = await ownerPrincipal(ownerId);
  const entries = (await overlayCall(overlay => overlay.due(principal, now)))
    .map(entry => ({ entry, userId: userIdOf(entry.refs) })).filter((value): value is { entry: typeof value.entry; userId: string } => value.userId !== null);
  if (!entries.length) return { due: [] };
  const session = getDriver().session();
  try {
    // Current name and picture, and never someone blocked in either direction.
    const result = await session.run(`
      MATCH (owner:User {id: $ownerId}), (subject:User) WHERE subject.id IN $userIds
        AND NOT (owner)-[:BLOCKED]->(subject) AND NOT (subject)-[:BLOCKED]->(owner)
      RETURN subject.id AS id, ${displayName} AS name, subject.avatarUrl AS avatarUrl
    `, { ownerId, userIds: entries.map(value => value.userId), fallbackName: DEFAULT_PUBLIC_DISPLAY_NAME });
    const people = new Map(result.records.map(record => [String(record.get('id')), { name: String(record.get('name')), avatarUrl: (record.get('avatarUrl') as string | null) ?? null }]));
    return {
      due: entries.filter(value => people.has(value.userId)).map(({ entry, userId }) => ({
        userId, ...people.get(userId)!, important: entry.important, nextDueAt: entry.nextDueAt, lastContactAt: entry.lastContactAt,
      })),
    };
  } finally { await session.close(); }
}

async function eraseOrphanedAdjunctsIn(tx: Runner, ownerKeys: string[]): Promise<void> {
  for (const label of ['OpenChatNoteReview', 'OpenChatPrivateAsk']) {
    await tx.run(`MATCH (n:${label}) WHERE n.ownerKey IN $ownerKeys
      AND NOT EXISTS { MATCH (e:OverlayEntity {id:n.entityId,ownerKey:n.ownerKey}) } DETACH DELETE n`, { ownerKeys });
  }
}

async function eraseCanonicalEntitiesIn<T>(tx: Runner, erase: (runner: Parameters<typeof purgeRefIn>[0]) => Promise<T>) {
  const touched = new Map<string, { id: string; ownerKey: string }>();
  const runner: Runner = {
    run: async (query, parameters) => {
      const result = await tx.run(query, parameters);
      if (typeof parameters?.ownerKey === 'string' && typeof parameters.id === 'string') {
        const entity = { id: parameters.id, ownerKey: parameters.ownerKey };
        touched.set(JSON.stringify([entity.ownerKey, entity.id]), entity);
      }
      return result;
    },
  };
  const result = await erase(runner as Parameters<typeof purgeRefIn>[0]);
  const entities = [...touched.values()];
  for (const label of ['OpenChatNoteReview', 'OpenChatPrivateAsk']) {
    await tx.run(`UNWIND $entities AS entity
      MATCH (n:${label} {ownerKey:entity.ownerKey,entityId:entity.id})
      WHERE NOT EXISTS { MATCH (:OverlayEntity {id:entity.id,ownerKey:entity.ownerKey}) }
      DETACH DELETE n`, { entities });
  }
  return { result, entities };
}


/**
 * Account deletion, inside the caller's transaction: everything this person
 * kept, under either identity that can name them, and every other owner's
 * entity that knew this person only as an OpenChat account.
 */
export async function deletePrivateGraphForUser(tx: Runner, userId: string): Promise<void> {
  await lockPrivateGraphAccountsIn(tx, [userId]);
  const identity = await tx.run('MATCH (user:User {id: $userId}) RETURN user.ideaflowIssuer AS issuer, user.ideaflowSub AS subject', { userId });
  const issuer = identity.records[0]?.get('issuer'), subject = identity.records[0]?.get('subject');
  const runner = tx as unknown as Parameters<typeof deleteOwnerIn>[0];
  await deleteOwnerIn(runner, fallbackKey(userId));
  if (typeof issuer === 'string' && issuer && typeof subject === 'string' && subject) await deleteOwnerIn(runner, ownerKeyFor(issuer, subject));
  const ownerKeys = [fallbackKey(userId)];
  if (typeof issuer === 'string' && issuer && typeof subject === 'string' && subject) ownerKeys.push(ownerKeyFor(issuer, subject));
  const { entities } = await eraseCanonicalEntitiesIn(tx, canonical => purgeRefIn(canonical, userRef(userId)));
  await eraseOrphanedAdjunctsIn(tx, [...new Set(ownerKeys)]);
  const surviving = await tx.run(`UNWIND $entities AS entity
    MATCH (e:OverlayEntity {id:entity.id,ownerKey:entity.ownerKey}),
      (r:OpenChatNoteReview {entityId:entity.id,ownerKey:entity.ownerKey})
    WITH e,r ORDER BY r.id SET r._lock=true REMOVE r._lock
    RETURN r.id AS id,r.ownerKey AS ownerKey,r.entityId AS entityId,r.payload AS payload,
      [(ref:OverlayRef {ownerKey:e.ownerKey})-[:REF_OF]->(e) | ref.ref] AS refs`, {
    entities,
  });
  for (const row of surviving.records) {
    const review = JSON.parse(String(row.get('payload')));
    if (review.subject?.kind !== 'user' || review.subject.id !== userId) continue;
    const survivingUserId = userIdOf(row.get('refs') as string[]);
    review.subject = survivingUserId === null ? { kind: 'thing', id: String(row.get('entityId')) } : { kind: 'user', id: survivingUserId };
    await tx.run('MATCH (r:OpenChatNoteReview {id:$id,ownerKey:$ownerKey}) SET r.payload=$payload', {
      id: row.get('id'), ownerKey: row.get('ownerKey'), payload: JSON.stringify(review),
    });
  }
}

/** Account export: the owner's whole private graph, as plain rows. */
export async function exportPrivateGraph(userId: string): Promise<{ entities: unknown[]; notes: unknown[]; links: unknown[]; noteReviews: unknown[]; privateAsks: unknown[] }> {
  const principal = await ownerPrincipal(userId);
  const result = await overlayCall(overlay => overlay.exportOwner(principal));
  const db = getDriver().session();
  try {
    const reviews = await db.run('MATCH (r:OpenChatNoteReview {ownerKey:$ownerKey}) RETURN r.payload AS payload', { ownerKey: principal.ownerKey });
    const asks = await db.run('MATCH (a:OpenChatPrivateAsk {ownerKey:$ownerKey}) RETURN properties(a) AS ask', { ownerKey: principal.ownerKey });
    return { ...result, noteReviews: reviews.records.map(r => JSON.parse(String(r.get('payload')))), privateAsks: asks.records.map(r => r.get('ask')) };
  } finally { await db.close(); }
}

export async function ensurePrivateGraphIndexes(): Promise<void> {
  await store();
  const db = getDriver().session();
  try {
    for (const label of ['OpenChatNoteReview', 'OpenChatPrivateAsk']) {
      await db.run(`CREATE CONSTRAINT ${label.toLowerCase()}_id IF NOT EXISTS FOR (n:${label}) REQUIRE n.id IS UNIQUE`);
      await db.run(`CREATE INDEX ${label.toLowerCase()}_subject IF NOT EXISTS FOR (n:${label}) ON (n.ownerKey,n.entityId)`);
    }
    await db.run('CREATE CONSTRAINT openchatnotereview_request IF NOT EXISTS FOR (r:OpenChatNoteReview) REQUIRE (r.ownerKey,r.entityId,r.requestId) IS UNIQUE');
  } finally { await db.close(); }
}

/** Verified adapter for OpenChat-only review records; the shared overlay contract stays unchanged. */
export async function lockPrivateReviewSubjectIn(tx: Runner, ownerKey: string, entityId: string, subject: { kind: 'user' | 'thing'; id: string }, ownerId: string): Promise<{ entityId: string; subject: { kind: 'user' | 'thing'; id: string } }> {
  const initial = await tx.run(`MATCH (e:OverlayEntity {id:$entityId,ownerKey:$ownerKey})
    RETURN [(r:OverlayRef {ownerKey:$ownerKey})-[:REF_OF]->(e) | r.ref] AS refs`, { entityId, ownerKey });
  const accountIds = ((initial.records[0]?.get('refs') ?? []) as string[]).filter(ref => ref.startsWith(USER_REF)).map(ref => decodeURIComponent(ref.slice(USER_REF.length)));
  const present = await lockPrivateGraphAccountsIn(tx, [ownerId,...accountIds,...(subject.kind === 'user' ? [subject.id] : [])]);
  await assertPrivateGraphOwnerIn(tx, ownerId, ownerKey);
  await tx.run('MERGE (c:OverlayBlurbClock {ownerKey:$ownerKey}) ON CREATE SET c.sequence=0 SET c._lock=true REMOVE c._lock', { ownerKey });
  const locked = await tx.run(`MATCH (requested:OverlayEntity {id:$entityId,ownerKey:$ownerKey})
    MATCH (e:OverlayEntity {id:coalesce(requested.mergedInto,requested.id),ownerKey:$ownerKey}) SET e._lock=true REMOVE e._lock
    RETURN e.id AS entityId, [(r:OverlayRef {ownerKey:$ownerKey})-[:REF_OF]->(e) | r.ref] AS refs`, { entityId, ownerKey });
  if (!locked.records.length) return fail(404, 'Not found');
  entityId = String(locked.records[0]!.get('entityId'));
  const refs = locked.records[0]!.get('refs') as string[];
  const currentUserId = subject.kind === 'user' && refs.includes(userRef(subject.id)) ? subject.id : userIdOf(refs);
  if (currentUserId !== null) {
    if (!present.has(currentUserId)) return fail(404, 'Person unavailable');
    await personRecordIn(tx, ownerId, currentUserId);
    return { entityId, subject: { kind: 'user', id: currentUserId } };
  }
  return { entityId, subject: { kind: 'thing', id: entityId } };
}

export async function privateReviewSubject(ownerId: string, subject: { kind: 'user' | 'thing'; id: string }, create = true): Promise<{ principal: OverlayPrincipal; entityId: string; name: string }> {
  if (subject.kind === 'user') {
    if (!create) {
      const { principal, person } = await assertPerson(ownerId, subject.id);
      const found = await overlayCall(overlay => overlay.lookup(principal, userRef(subject.id)));
      return { principal, entityId: found?.id ?? '', name: person.name };
    }
    const resolved = await personEntity(ownerId, subject.id);
    return { principal: resolved.principal, entityId: resolved.entityId, name: resolved.person.name };
  }
  const principal = await ownerPrincipal(ownerId);
  const found = await overlayCall(overlay => overlay.get(principal, subject.id));
  if (userIdOf(found.refs) !== null) fail(404, 'Not found');
  return { principal, entityId: found.id, name: found.name };
}
export { ownerPrincipal as privateReviewPrincipal };

// ---- asks: the Noos overlay's `ask` kind (OpenChat-2fsy.1, 2026-11-03) ----

/** A party as the app names it: the owner (`self`) or an end like any other (OpenChat person by user id, Unlinked person, saved thing by id). */
export type AskPartyView = { kind: 'self' } | LinkEnd;
/** A place an ask was put: the owner's stream, a person or thing, a conversation, or another app's ref. */
export type AskPlacementView = AskPartyView | { kind: 'conversation'; conversationId: string } | { kind: 'ref'; ref: string };
/**
 * An ask as the app and agent tools see it. Who cares (`author`, always set),
 * who acts (`carrier`, optional) and where it was placed (`placements`) are
 * separate facts, as in the Gestalt Box model; `fromMe` and `forMe` follow
 * from them. Owner-only, like everything here: `exposure` records whom the
 * owner means it for and widens nothing yet.
 */
export interface PrivateAskView {
  id: string; text: string; authorParty: AskPartyView; author: string | null; source: string | null; own: boolean; asker: Exclude<AskPartyView, { kind: 'self' }> | null; sources: Ask['sources']; carrier: AskPartyView | null; placements: AskPlacementView[]; fromMe: boolean; forMe: boolean;
  horizon: AskHorizon; recheckAfter: string; needsRecheck: boolean; status: AskStatus;
  exposure: AskExposure; exposureConversationId: string | null; evidence: AskEvidence | null;
  createdAt: string; updatedAt: string; updatedBy: string | null; closedAt: string | null; checkedAt: string | null; revision: number;
  recordedBy: string | null; recordedVia: string | null; assertion: string | null;
  publication: { state: 'active' | 'revoked'; audienceKind: 'public' | 'people'; sourceRevision: number } | null;
}
/** A party as given: the owner (`self`), or a subject as notes and links name it. */
export type AskPartyInput = { kind: 'self' } | Subject;
/** The note-review statuses the app used before asks moved into the overlay, read as overlay statuses. */
export const LEGACY_ASK_STATUS: Record<string, AskStatus> = { active: 'open', paused: 'stale', closed: 'withdrawn' };
const CONVERSATION_REF = 'openchat:conversation:';
const conversationIdOf = (ref: string | null): string | null => ref?.startsWith(CONVERSATION_REF) ? decodeURIComponent(ref.slice(CONVERSATION_REF.length)) : null;

export function parseAskParty(value: unknown, message: string = MESSAGES.invalid_author!): AskPartyInput {
  if (value === 'self' || value === 'owner' || value === 'owner') return { kind: 'self' };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(400, message);
  const input = value as Record<string, unknown>;
  if (input.kind === 'self') return { kind: 'self' };
  if ((input.kind !== 'user' && input.kind !== 'thing' && input.kind !== 'unlinked') || typeof input.id !== 'string' || !input.id || input.id.length > 512) return fail(400, message);
  return { kind: input.kind, id: input.id };
}

/** A conversation the owner is in, as an overlay ref (a `this_chat` exposure, or a placement). */
async function conversationRef(ownerId: string, conversationId: unknown, message: string = MESSAGES.invalid_exposure!): Promise<string> {
  if (typeof conversationId !== 'string' || !conversationId || conversationId.length > 200) return fail(400, message);
  const session = getDriver().session();
  try {
    const found = await session.run('MATCH (:User {id: $ownerId})-[:PARTICIPATES_IN]->(c:Conversation {id: $conversationId}) RETURN c.id AS id LIMIT 1', { ownerId, conversationId });
    if (!found.records.length) return fail(404, 'Conversation not found');
  } finally { await session.close(); }
  return `${CONVERSATION_REF}${refValue(conversationId)}`;
}

/** A party as the overlay takes it (`'self'` or `{id}`); a person named for the first time gets an entity, as notes and links do. */
async function overlayParty(ownerId: string, party: AskPartyInput): Promise<'self' | { id: string }> {
  return party.kind === 'self' ? 'self' : { id: (await subjectEntity(ownerId, party)).entityId };
}
type PlacementInput = { conversationRef: string } | AskPartyInput;
/** Placements as given: a party, or `{kind: 'conversation', id}` the owner is in (checked here; nothing is written). */
async function parsePlacements(ownerId: string, value: unknown): Promise<PlacementInput[]> {
  if (!Array.isArray(value) || value.length > 8) return fail(400, MESSAGES.invalid_placement!);
  const result: PlacementInput[] = [];
  for (const item of value) {
    if (item && typeof item === 'object' && (item as Record<string, unknown>).kind === 'conversation') result.push({ conversationRef: await conversationRef(ownerId, (item as Record<string, unknown>).id, MESSAGES.invalid_placement) });
    else result.push(parseAskParty(item, MESSAGES.invalid_placement));
  }
  return result;
}
const isEnd = (party: unknown): party is OverlayLinkEnd => !!party && typeof party === 'object' && Array.isArray((party as { refs?: unknown }).refs);
/** Asks among these entities whose author or carrier is someone blocked either way, or gone: search and neighbourhood leave them out, as the ask lists do. */
async function hiddenAskIds(ownerId: string, principal: OverlayPrincipal, entities: Array<{ id: string; kind: string }>): Promise<Set<string>> {
  const ids = [...new Set(entities.filter(entity => entity.kind === 'ask').map(entity => entity.id))];
  if (!ids.length) return new Set();
  const asks = (await Promise.all(ids.map(id => overlayCall(overlay => overlay.getAsk(principal, id)).catch(() => null)))).filter((ask): ask is Ask => ask !== null);
  const blocked = await blockedUserIds(ownerId, asks.flatMap(ask => [ask.author, ask.carrier].filter(isEnd)));
  return new Set(asks.filter(ask => [ask.author, ask.carrier].some(party => { const userId = isEnd(party) ? userIdOf(party.refs) : null; return userId !== null && blocked.has(userId); })).map(ask => ask.id));
}

/** Asks as the app shows them. An ask by (or carried by) someone blocked either way, or gone, is left out; such a placement is dropped. */
async function askViews(ownerId: string, asks: Ask[]): Promise<PrivateAskView[]> {
  const publications = new Map<string, PrivateAskView['publication']>();
  if (asks.length) {
    const { ownerKey } = await ownerPrincipal(ownerId), db = getDriver().session();
    try {
      const result = await db.run('MATCH (p:OverlayAskPublication {ownerKey:$ownerKey}) WHERE p.askId IN $ids RETURN p.askId AS askId,p.state AS state,p.audienceKind AS audienceKind,p.sourceRevision AS sourceRevision', { ownerKey, ids: asks.map(ask => ask.id) });
      for (const row of result.records) publications.set(String(row.get('askId')), { state: row.get('state'), audienceKind: row.get('audienceKind'), sourceRevision: Number(row.get('sourceRevision')?.toString() ?? 0) });
    } finally { await db.close(); }
  }

  const ends = asks.flatMap(ask => [ask.author, ask.carrier, ...ask.placements].filter(isEnd));
  const hidden = await blockedUserIds(ownerId, ends), names = await userNames(ends), connections = await connectionsFor(ownerId, ends);
  const blocked = (party: unknown) => { const userId = isEnd(party) ? userIdOf(party.refs) : null; return userId !== null && hidden.has(userId); };
  const party = (value: Ask['author']): AskPartyView | null => value === null ? null : isEnd(value) ? endOf(value, names, connections) : { kind: 'self' };
  return asks.filter(ask => ask.author !== null && !blocked(ask.author) && !blocked(ask.carrier)).map(ask => ({
    id: ask.id, text: ask.text, authorParty: party(ask.author)!, author: ask.recordedBy, source: ask.recordedVia, own: ask.fromMe, asker: ask.fromMe ? null : party(ask.author) as Exclude<AskPartyView, { kind: 'self' }>, sources: ask.sources, carrier: party(ask.carrier),
    placements: ask.placements.filter(place => !blocked(place)).map((place): AskPlacementView => place.kind === 'ref'
      ? (conversationIdOf(place.ref) !== null ? { kind: 'conversation', conversationId: conversationIdOf(place.ref)! } : { kind: 'ref', ref: place.ref }) : party(place as Ask['author'])!),
    fromMe: ask.fromMe, forMe: ask.forMe, horizon: ask.horizon, recheckAfter: ask.recheckAfter,
    needsRecheck: ask.needsRecheck, status: ask.status, exposure: ask.exposure, exposureConversationId: conversationIdOf(ask.exposureChat), evidence: ask.evidence,
    createdAt: ask.createdAt, updatedAt: ask.updatedAt, updatedBy: ask.updatedBy, closedAt: ask.closedAt, checkedAt: ask.checkedAt, revision: ask.revision,
    recordedBy: ask.recordedBy, recordedVia: ask.recordedVia, assertion: ask.assertion, publication: publications.get(ask.id) ?? null,
  }));
}
const oneView = async (ownerId: string, ask: Ask): Promise<PrivateAskView> => (await askViews(ownerId, [ask]))[0] ?? fail(404, 'Not found');

/**
 * The app's ask fields, checked before anything is written: legacy statuses
 * are read as overlay ones, `exposureConversationId` becomes the `this_chat`
 * ref, and the carrier and placements are parsed (conversations checked) but
 * not yet resolved, so a request refused for any other reason creates no
 * person card.
 */
async function askFields(ownerId: string, raw: Record<string, unknown>): Promise<{ fields: Record<string, unknown>; carrier?: AskPartyInput | null; placements?: PlacementInput[] }> {
  const { exposureConversationId, exposureChat, assertion: _assertion, carrier, placements, ...fields } = raw;
  if (exposureChat !== undefined) fail(400, MESSAGES.invalid_exposure!);
  if (typeof fields.status === 'string' && LEGACY_ASK_STATUS[fields.status]) fields.status = LEGACY_ASK_STATUS[fields.status];
  if (fields.exposure === 'this_chat') fields.exposureChat = await conversationRef(ownerId, exposureConversationId);
  else if (exposureConversationId !== undefined && exposureConversationId !== null && exposureConversationId !== '') fail(400, MESSAGES.invalid_exposure!);
  return {
    fields,
    ...(carrier !== undefined ? { carrier: carrier === null ? null : parseAskParty(carrier, MESSAGES.invalid_carrier) } : {}),
    ...(placements !== undefined ? { placements: await parsePlacements(ownerId, placements) } : {}),
  };
}
/** The parsed parties as the overlay takes them; a person named for the first time gets an entity here, after every other check passed. */
async function resolveParties(ownerId: string, parsed: { carrier?: AskPartyInput | null; placements?: PlacementInput[] }): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  if (parsed.carrier !== undefined) result.carrier = parsed.carrier === null ? null : await overlayParty(ownerId, parsed.carrier);
  if (parsed.placements !== undefined) {
    const placements: unknown[] = [];
    for (const place of parsed.placements) placements.push('conversationRef' in place ? { ref: place.conversationRef } : await overlayParty(ownerId, place));
    result.placements = placements;
  }
  return result;
}

/**
 * Save an ask. `author` is who cares (required): `'self'`, an OpenChat person
 * by user id, an Unlinked person, or a saved person, company, project or idea.
 * `carrier` (who acts) and `placements` (the owner's stream, a person or
 * thing, a conversation) are optional. The same author and text is one ask
 * (`created: false`). `asker` is read as `author` (earlier clients).
 */
export async function saveAsk(ownerId: string, raw: unknown, by: Provenance = OWNER_PROVENANCE): Promise<{ ask: PrivateAskView; created: boolean }> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(400, MESSAGES.invalid_ask!);
  const { author: rawAuthor, asker, ...rest } = raw as Record<string, unknown>;
  if (rawAuthor !== undefined && asker !== undefined) fail(400, 'Give author or asker, not both');
  const author = parseAskParty(rawAuthor ?? asker);
  const principal = await ownerPrincipal(ownerId);
  const parsed = await askFields(ownerId, rest);
  // Every check that needs no person card first: a refused ask leaves nothing behind.
  await overlayCall(async () => parseAskInput({ ...parsed.fields, author: 'self' }));
  const overlayAuthor = await overlayParty(ownerId, author);
  const parties = await resolveParties(ownerId, parsed);
  const result = await overlayCall(overlay => overlay.saveAsk(principal, { ...parsed.fields, ...parties, author: overlayAuthor }, by));
  return { ask: await oneView(ownerId, result.ask), created: result.created };
}

/** The owner's entity for a subject, without creating one; null when nobody has written about it. */
async function existingEntity(ownerId: string, principal: OverlayPrincipal, subject: Subject): Promise<string | null> {
  if (subject.kind === 'user') { await assertPerson(ownerId, subject.id); return (await overlayCall(overlay => overlay.lookup(principal, userRef(subject.id))))?.id ?? null; }
  if (subject.kind === 'unlinked') return (await findUnlinkedEntity(ownerId, principal, subject.id)).found?.id ?? null;
  return subject.id;
}

/**
 * The owner's asks: open and stale first, by when they are due for a
 * recheck. `direction` is `from_me` (I care), `for_me` (placed on my stream,
 * or I carry it) or `from_others`; `aboutKind` + `aboutId` (user, thing or
 * unlinked) keeps asks that person or thing cares about, carries or is
 * placed on. `status` is one or a comma list, or `all`.
 */
export async function listAsks(ownerId: string, input: { status?: unknown; direction?: unknown; aboutKind?: unknown; aboutId?: unknown; askerKind?: unknown; askerId?: unknown; asker?: unknown; q?: unknown; needsRecheck?: unknown; limit?: unknown }): Promise<{ asks: PrivateAskView[]; truncated: boolean }> {
  const principal = await ownerPrincipal(ownerId);
  const hasLegacy = input.asker !== undefined || input.askerKind !== undefined || input.askerId !== undefined;
  if (hasLegacy && (input.direction !== undefined || input.aboutKind !== undefined || input.aboutId !== undefined)) fail(400, 'Give a legacy asker filter or a direction/about filter, not both');
  let direction: unknown = input.direction;
  let legacyAsker: unknown;
  if (input.askerKind !== undefined || input.askerId !== undefined) {
    if (input.asker !== undefined) fail(400, 'Give asker or askerKind/askerId, not both');
    const subject = parseAskParty({ kind: input.askerKind, id: input.askerId });
    legacyAsker = subject.kind === 'self' ? 'owner' : await existingEntity(ownerId, principal, subject);
    if (!legacyAsker) return { asks: [], truncated: false };
  } else if (input.asker !== undefined) {
    if (input.asker !== 'self' && input.asker !== 'owner' && input.asker !== 'others') fail(400, MESSAGES.invalid_direction!);
    legacyAsker = input.asker === 'self' ? 'owner' : input.asker;
  }
  if (direction !== undefined && direction !== '' && direction !== 'from_me' && direction !== 'for_me' && direction !== 'from_others') fail(400, MESSAGES.invalid_direction!);
  if (input.aboutKind !== undefined || input.aboutId !== undefined) {
    if (direction) fail(400, 'Give a direction or an aboutKind and aboutId, not both');
    const subject = parseAskParty({ kind: input.aboutKind, id: input.aboutId }, 'Choose who the asks are about: aboutKind user, thing or unlinked, and its id');
    if (subject.kind === 'self') direction = 'from_me';
    else {
      const entityId = await existingEntity(ownerId, principal, subject);
      if (!entityId) return { asks: [], truncated: false };
      direction = `about:${entityId}`;
    }
  }
  const status = typeof input.status === 'string' ? input.status.split(',').map(value => LEGACY_ASK_STATUS[value.trim()] ?? value.trim()).join(',') : input.status;
  const found = await overlayCall(overlay => overlay.listAsks(principal, { status, direction, asker: legacyAsker, q: input.q, needsRecheck: input.needsRecheck, limit: input.limit }));
  return { asks: await askViews(ownerId, found.asks), truncated: found.truncated };
}

export async function getAsk(ownerId: string, askId: string): Promise<PrivateAskView> {
  const principal = await ownerPrincipal(ownerId);
  return oneView(ownerId, await overlayCall(overlay => overlay.getAsk(principal, askId)));
}

/** Edit an ask in place (text, carrier, placements, horizon, recheckAfter, status, exposure, evidence, recheckedNow); `updatedBy` records the editor. The author never changes. */
export async function updateAsk(ownerId: string, askId: string, raw: unknown, by: Provenance = OWNER_PROVENANCE): Promise<PrivateAskView> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(400, 'Nothing to change');
  if ('author' in raw || 'asker' in raw) fail(400, MESSAGES.author_fixed!);
  const principal = await ownerPrincipal(ownerId);
  const parsed = await askFields(ownerId, raw as Record<string, unknown>);
  // The ask must be the owner's, and the rest of the edit valid, before any person card is made.
  await overlayCall(overlay => overlay.getAsk(principal, askId));
  if (Object.keys(parsed.fields).length) await overlayCall(async () => parseAskPatch(parsed.fields));
  const parties = await resolveParties(ownerId, parsed);
  return oneView(ownerId, await overlayCall(overlay => overlay.updateAsk(principal, askId, { ...parsed.fields, ...parties }, by)));
}

/** Forget an ask with its notes and links (the undo for saveAsk). Anything that is not one of the owner's asks is 404. */
export async function deleteAsk(ownerId: string, askId: string): Promise<{ deleted: true; id: string }> {
  const principal = await ownerPrincipal(ownerId);
  await overlayCall(async overlay => { await overlay.getAsk(principal, askId); await overlay.deleteEntity(principal, askId); });
  return { deleted: true, id: askId };
}

// ---- lists: the Noos overlay's owner-private `list` kind (Noos #105, 2026-11-05) ----

/**
 * A list is one of the owner's saved things of kind `list`; its members are
 * the people it has an outgoing `contains` link to (an OpenChat person, an
 * Unlinked person or a saved person). Membership is the owner's own
 * bookkeeping: it is not evidence that they know the person, and it is never
 * shown to the member or anyone else. Imports (Unlinked's CSV path) write the
 * same links. Removing a member is a graph edit wherever the owner looks, not
 * a withdrawal of one import's contribution, and there is no suppression
 * tombstone: a later or still-running import can add the person back (see
 * docs/private-graph.md, "Lists"). Lists are addressed by id: an imported list
 * can share its name with another.
 */
export const LIST_MEMBERSHIP = 'contains';
export interface ListMember { linkId: string; member: LinkEnd; addedAt: string; author: string | null; source: string | null }
const MEMBER_KINDS = ['user', 'unlinked', 'person'] as const;

/** The owner's list by id: 404 for anything that is not one of their lists. */
async function ownList(principal: OverlayPrincipal, listId: string): Promise<Entity> {
  if (typeof listId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(listId)) return fail(404, 'Not found');
  const found = await overlayCall(overlay => overlay.get(principal, listId));
  if (found.kind !== 'list') fail(404, 'Not found');
  return found;
}

/**
 * One page of a list's members, through the overlay's owner-bound link pages:
 * `after` is the previous page's `nextCursor`, unchanged. A page can hold
 * fewer than `limit` members (other links on the list are skipped, as are
 * people blocked either way); `nextCursor` is null only at the end.
 */
export async function listMembers(ownerId: string, listId: string, input: { after?: unknown; limit?: unknown } = {}): Promise<{ list: Thing; members: ListMember[]; nextCursor: string | null }> {
  const principal = await ownerPrincipal(ownerId);
  const list = await ownList(principal, listId);
  const after = typeof input.after === 'string' && input.after ? input.after : undefined;
  const limit = input.limit === undefined || input.limit === '' ? undefined : input.limit;
  const page = await overlayCall(overlay => overlay.linksPage(principal, listId, { ...(after ? { after } : {}), ...(limit !== undefined ? { limit } : {}) }));
  // People only, however the link was written (the generic link routes cannot add other members, but older data might).
  const links = page.links.filter(link => link.direction === 'out' && link.relation === LIST_MEMBERSHIP && link.other.kind === 'person');
  const ends = links.map(link => link.other);
  const hidden = await blockedUserIds(ownerId, ends), names = await userNames(ends), connections = await connectionsFor(ownerId, ends);
  const members = links.filter(link => { const userId = userIdOf(link.other.refs); return userId === null || !hidden.has(userId); }).map(link => ({
    linkId: link.id, member: endOf(link.other, names, connections), addedAt: link.createdAt, author: link.author ?? null, source: link.source ?? null,
  }));
  return { list: thingOf(list), members, nextCursor: page.nextCursor };
}

/**
 * Add someone to a list: an OpenChat person (`user` + id), an Unlinked person
 * (`unlinked` + profile id, connection id or LinkedIn address) or a saved
 * person (`person` + id, or a name with the usual never-merge rules). Adding
 * someone already on the list returns the existing membership.
 */
export async function addListMember(ownerId: string, listId: string, rawMember: unknown, by: Provenance = OWNER_PROVENANCE): Promise<ListMember> {
  const principal = await ownerPrincipal(ownerId);
  await ownList(principal, listId);
  const kind = (rawMember as { kind?: unknown } | null)?.kind;
  if (!MEMBER_KINDS.includes(kind as typeof MEMBER_KINDS[number])) fail(400, 'Add a person: kind user (OpenChat), unlinked (Unlinked) or person (saved), with an id or a name');
  const link = await addLink(ownerId, { kind: 'thing', id: listId }, LIST_MEMBERSHIP, rawMember, by);
  return { linkId: link.id, member: link.other, addedAt: link.createdAt, author: link.author, source: link.source };
}

/** Remove one membership by its link id (from listMembers). Anything that is not a `contains` link of the owner's list is 404. */
export async function removeListMember(ownerId: string, listId: string, linkId: string): Promise<{ removed: true; linkId: string }> {
  const principal = await ownerPrincipal(ownerId);
  await ownList(principal, listId);
  const session = getDriver().session();
  try {
    const found = await session.run(`MATCH (:OverlayEntity {id: $listId, ownerKey: $ownerKey, kind: 'list'})-[l:OVERLAY_LINK {id: $linkId}]->(:OverlayEntity {ownerKey: $ownerKey, kind: 'person'})
      WHERE l.ownerKey = $ownerKey AND l.relation = $relation RETURN l.id AS id`, { listId, linkId, ownerKey: principal.ownerKey, relation: LIST_MEMBERSHIP });
    if (!found.records.length) return fail(404, 'Not found');
  } finally { await session.close(); }
  await overlayCall(overlay => overlay.deleteLink(principal, linkId));
  return { removed: true, linkId };
}
