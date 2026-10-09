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

import { getDriver } from '../db.js';
import { DEFAULT_PUBLIC_DISPLAY_NAME } from '../privacy/profilePrivacy.js';
import { linkedinHashOf, linkedinRef, OverlayError, OWNER_PROVENANCE, ownerKeyFor, RELATION_TYPES } from './overlay/contract.js';
import type { Candidate, Edge, Entity, EntityDetail, Link as OverlayLink, OverlayPrincipal, Provenance, RelationType } from './overlay/contract.js';
import { deleteEntityIn, deleteNoteIn, deleteOwnerIn, OverlayStore, purgeRefIn } from './overlay/store.js';
import { lookupUnlinkedContactForIdentity, lookupUnlinkedContactsByHash } from './unlinkedProvision.js';
import type { UnlinkedContact } from './unlinkedProvision.js';

export class PrivateGraphError extends Error {
  /** Extra response fields, such as the candidates for an ambiguous name. */
  constructor(public status: number, message: string, public details?: Record<string, unknown>) { super(message); }
}

export const THING_KINDS = ['person', 'company', 'idea', 'project'] as const;
export type ThingKind = typeof THING_KINDS[number];
export type NodeKind = 'user' | ThingKind;
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
export interface PrivateNote extends Provenance { id: string; text: string; createdAt: string; updatedAt: string }
/**
 * `unlinkedProfileId` is set when the end is a published Unlinked profile
 * (overlay ref `unlinked:person:<id>`); `linkedinRefHash` when it is one of the
 * owner's imported LinkedIn contacts (ref `linkedin:in:<hash>`), with
 * `unlinkedConnectionId` (the id from unlinked_list_connections) when Unlinked
 * could name it. `id` is then its saved-thing id.
 */
export interface LinkEnd { kind: NodeKind; id: string; name: string; unlinkedProfileId?: string; linkedinRefHash?: string; unlinkedConnectionId?: string }
export interface PrivateLink extends Provenance { id: string; relation: string; relationType: RelationType; direction: 'out' | 'in'; other: LinkEnd; createdAt: string; updatedAt: string | null }
export interface PersonBasics { id: string; name: string; avatarUrl: string | null }
export interface PersonOverlay { userId: string; person: PersonBasics; card: PersonCard; notes: PrivateNote[]; links: PrivateLink[] }
export interface Thing { id: string; kind: ThingKind; name: string }
export interface ThingDetail extends Thing { notes: PrivateNote[]; links: PrivateLink[]; unlinkedProfileId?: string; linkedinRefHash?: string; unlinkedConnectionId?: string }
/** An Unlinked person: a published profile (`profileId`) and/or one of the owner's imported contacts (`connectionId`, `linkedinRefHash`). */
export interface UnlinkedPersonOverlay { profileId: string | null; connectionId: string | null; linkedinRefHash: string | null; thingId: string | null; name: string | null; card: PersonCard; notes: PrivateNote[]; links: PrivateLink[] }
export interface OwnerLink extends Provenance { id: string; relation: string; relationType: RelationType; from: LinkEnd; to: LinkEnd; createdAt: string; updatedAt: string | null }
export interface PrivateSearch { things: Array<LinkEnd & { matched: Array<'name' | 'note'> }>; links: OwnerLink[]; truncated: boolean }
export interface PrivateNeighbourhood { center: LinkEnd; depth: 1 | 2; nodes: LinkEnd[]; links: OwnerLink[]; truncated: boolean }
/** Who a link or note is about: an OpenChat person, a saved thing, or an Unlinked person (published profile id, owner connection id or LinkedIn address). */
export type Subject = { kind: 'user' | 'thing' | 'unlinked'; id: string };
export interface DuePerson { userId: string; name: string; avatarUrl: string | null; important: boolean; nextDueAt: string; lastContactAt: string | null }

export const LIMITS = { noteLength: 4000, notesPerSubject: 200, linksPerOwner: 5000, thingsPerOwner: 5000, relationLength: 60, nameLength: 120, cadenceDays: 3650 } as const;
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
  if (!THING_KINDS.includes(input.kind as ThingKind)) return fail(400, 'Choose a person, company, idea or project');
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
async function store(): Promise<OverlayStore> {
  overlay ??= new OverlayStore(getDriver(), process.env.NEO4J_DATABASE || 'neo4j');
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
};
/** Overlay refusals become the app's own wording; anything else stays an unexpected error. */
async function overlayCall<T>(work: (overlay: OverlayStore) => Promise<T>): Promise<T> {
  try { return await work(await store()); }
  catch (error) {
    if (error instanceof OverlayError && error.code === 'ambiguous_name') fail(409, String(error.details?.message ?? 'More than one saved item has that name. Choose one by id, or set createNew with a clientRequestId for a different one.'), { code: 'ambiguous_name', candidates: candidatesFor(error.details?.candidates) });
    if (error instanceof OverlayError && error.status < 500) fail(error.status, MESSAGES[error.code] ?? 'Check what you entered and try again');
    throw error;
  }
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
    const result = await session.run(`
      MATCH (owner:User {id: $ownerId}), (subject:User {id: $userId})
      RETURN coalesce(subject.isBot, false) AS isBot,
        ((owner)-[:BLOCKED]->(subject) OR (subject)-[:BLOCKED]->(owner)) AS blocked,
        coalesce(subject.name, 'Unknown') AS name, subject.avatarUrl AS avatarUrl, ${displayName} AS shownName,
        owner.ideaflowIssuer AS issuer, owner.ideaflowSub AS subjectId
    `, { ownerId, userId, fallbackName: DEFAULT_PUBLIC_DISPLAY_NAME });
    const record = result.records[0];
    if (!record || record.get('isBot') === true || record.get('blocked') === true) return fail(404, 'Person unavailable');
    return {
      person: { id: userId, name: String(record.get('name')), avatarUrl: (record.get('avatarUrl') as string | null) ?? null },
      principal: await principalFor(ownerId, record.get('issuer'), record.get('subjectId')),
      name: String(record.get('shownName')),
    };
  } finally { await session.close(); }
}

/** The overlay entity for an OpenChat person, created on first write. */
async function personEntity(ownerId: string, userId: string): Promise<{ principal: OverlayPrincipal; entityId: string; person: PersonBasics }> {
  const { person, principal, name } = await assertPerson(ownerId, userId);
  const { entity } = await overlayCall(overlay => overlay.ensure(principal, { kind: 'person', name, ref: userRef(userId) }));
  return { principal, entityId: entity.id, person };
}

/** Link ends as the app knows them: an OpenChat person by user id and current name, anything else by entity id. */
async function linksFor(ownerId: string, links: OverlayLink[], known?: Connections): Promise<PrivateLink[]> {
  const names = await userNames(links.map(link => link.other));
  const connections = await connectionsFor(ownerId, links.map(link => link.other), known);
  return links.map(link => ({ ...provenanceOf(link), id: link.id, relation: link.relation, relationType: link.relationType, direction: link.direction, other: endOf(link.other, names, connections), createdAt: link.createdAt, updatedAt: link.updatedAt }));
}
const provenanceOf = (value: Provenance): Provenance => ({ author: value.author, source: value.source, assertion: value.assertion });
function noteOf(note: PrivateNote): PrivateNote {
  return { id: note.id, text: note.text, createdAt: note.createdAt, updatedAt: note.updatedAt, ...provenanceOf(note) };
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
function endOf(entity: { id: string; kind: ThingKind; name: string; refs: string[] }, names: Map<string, string> = new Map(), connections: Connections = new Map()): LinkEnd {
  const userId = userIdOf(entity.refs);
  if (userId !== null) return { kind: 'user', id: userId, name: names.get(userId) ?? entity.name };
  return { kind: entity.kind, id: entity.id, name: entity.name, ...unlinkedFields(entity.refs, connections) };
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
async function namedEntity(principal: OverlayPrincipal, target: { kind: ThingKind; name: string; createNew?: { requestId: string } }): Promise<string> {
  try {
    return (await overlayCall(overlay => overlay.resolve(principal, { kind: target.kind, name: target.name, ...(target.createNew ? { createNew: true, clientRequestId: target.createNew.requestId } : {}) }))).entity.id;
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

export async function updatePersonCard(ownerId: string, userId: string, patch: CardPatch): Promise<PersonCard> {
  const { principal, entityId } = await personEntity(ownerId, userId);
  return (await overlayCall(overlay => overlay.update(principal, entityId, { card: patch }))).card;
}

/** The same text already on this card is the same note (the overlay dedupes): a retried request never doubles it. */
export async function addNote(ownerId: string, subject: Subject, rawText: unknown, by: Provenance = OWNER_PROVENANCE): Promise<PrivateNote> {
  const text = cleanText(rawText, LIMITS.noteLength, 'Note');
  const { principal, entityId } = await subjectEntity(ownerId, subject);
  return noteOf((await overlayCall(overlay => overlay.addNote(principal, entityId, text, by))).note);
}

export async function updateNote(ownerId: string, noteId: string, rawText: unknown): Promise<PrivateNote> {
  const text = cleanText(rawText, LIMITS.noteLength, 'Note');
  const principal = await ownerPrincipal(ownerId);
  return noteOf(await overlayCall(overlay => overlay.updateNote(principal, noteId, text)));
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

/**
 * Link a person, saved thing or Unlinked profile to another. The same subject,
 * relation and target is one link: repeating it returns the existing link.
 */
export async function addLink(ownerId: string, from: Subject, rawRelation: unknown, rawTarget: unknown, by: Provenance = OWNER_PROVENANCE): Promise<PrivateLink> {
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
  const { link } = await overlayCall(overlay => overlay.addLink(principal, fromId, relation, toId, by));
  return (await linksFor(ownerId, [link], known))[0]!;
}

/**
 * Change a link's relation text in place ("sister of" to "cousin of"). When
 * the owner already has the edited link, the two become one and the existing
 * link is returned with merged: true.
 */
export async function updateLink(ownerId: string, linkId: string, rawRelation: unknown, by: Provenance = OWNER_PROVENANCE): Promise<{ link: PrivateLink; merged: boolean }> {
  const relation = cleanRelation(rawRelation);
  const principal = await ownerPrincipal(ownerId);
  const { link, merged } = await overlayCall(overlay => overlay.updateLink(principal, linkId, relation, by));
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
  const exported = await overlayCall(overlay => overlay.exportOwner(principal)) as { entities: Array<{ id: string; kind: ThingKind; name: string; refs: string[] }>; links: Array<Edge & { fromId: string; toId: string }> };
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
function ownerLink(link: Edge, from: { id: string; kind: ThingKind; name: string; refs: string[] }, to: { id: string; kind: ThingKind; name: string; refs: string[] }, names: Map<string, string>, connections: Connections = new Map()): OwnerLink {
  return {
    id: link.id, relation: link.relation, relationType: link.relationType, from: endOf(from, names, connections), to: endOf(to, names, connections), createdAt: link.createdAt,
    updatedAt: link.updatedAt ?? null, author: link.author ?? null, source: link.source ?? null, assertion: link.assertion ?? null,
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
  if (kind !== undefined && kind !== '' && !THING_KINDS.includes(kind as ThingKind)) fail(400, 'Unknown kind');
  const found = await overlayCall(overlay => overlay.search(principal, { q: input.q, relationType: input.relationType, kind, limit: input.limit }));
  const hidden = await blockedUserIds(ownerId, [...found.entities, ...found.links.flatMap(link => [link.from, link.to])]);
  const names = await userNames([...found.entities, ...found.links.flatMap(link => [link.from, link.to])]);
  const visible = (end: { refs: string[] }) => { const userId = userIdOf(end.refs); return userId === null || !hidden.has(userId); };
  const connections = await connectionsFor(ownerId, [...found.entities, ...found.links.flatMap(link => [link.from, link.to])].filter(visible));
  return {
    things: found.entities.filter(visible).map(entity => ({ ...endOf(entity, names, connections), matched: entity.matched.filter((value): value is 'name' | 'note' => value !== 'link') })),
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
  const byId = new Map(all.map(entity => [entity.id, entity]));
  const visible = (entity: Entity | undefined): entity is Entity => { const userId = entity ? userIdOf(entity.refs) : null; return !!entity && (userId === null || !hidden.has(userId)); };
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
      for (const label of ['OpenChatNoteReview', 'OpenChatPrivateAsk']) await tx.run(`MATCH (n:${label} {ownerKey: $ownerKey, entityId: $thingId}) DETACH DELETE n`, { ownerKey, thingId });
      return deleteEntityIn(tx, ownerKey, thingId);
    });
    return { deleted: true, id: thingId, notesRemoved: removed.notesRemoved, linksRemoved: removed.linksRemoved };
  } catch (error) {
    if (error instanceof OverlayError && error.status < 500) fail(error.status, MESSAGES[error.code] ?? 'Check what you entered and try again');
    throw error;
  } finally { await db.close(); }
}

/** Save a private named subject; this never binds or creates an OpenChat account. */
export async function createPrivateThing(ownerId: string, rawKind: unknown, rawName: unknown): Promise<Thing> {
  if (!THING_KINDS.includes(rawKind as ThingKind)) fail(400, 'Choose a person, company, idea or project');
  const name = cleanText(rawName, LIMITS.nameLength, 'Name');
  const principal = await ownerPrincipal(ownerId);
  const { entity } = await overlayCall(overlay => overlay.ensure(principal, { kind: rawKind, name }));
  return { id: entity.id, kind: entity.kind, name: entity.name };
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
  const entityId = await namedEntity(principal, target);
  const entity = await overlayCall(overlay => overlay.get(principal, entityId));
  return { id: entity.id, kind: entity.kind, name: entity.name };
}

/** Saved companies, ideas, projects and people-by-name. People on OpenChat are reached through their profile instead. */
export async function listThings(ownerId: string, query: unknown, kind: unknown): Promise<{ things: Thing[] }> {
  if (kind !== undefined && !THING_KINDS.includes(kind as ThingKind)) fail(400, 'Unknown kind');
  const principal = await ownerPrincipal(ownerId);
  const entities = await overlayCall(overlay => overlay.list(principal, { q: typeof query === 'string' ? query : '', kind }));
  return { things: entities.filter(entity => userIdOf(entity.refs) === null).map(entity => ({ id: entity.id, kind: entity.kind, name: entity.name })) };
}

export async function getThing(ownerId: string, thingId: string): Promise<ThingDetail> {
  const principal = await ownerPrincipal(ownerId);
  const found: EntityDetail = await overlayCall(overlay => overlay.get(principal, thingId));
  if (userIdOf(found.refs) !== null) fail(404, 'Not found');
  const connections = await connectionsFor(ownerId, [found, ...found.links.map(link => link.other)]);
  return { id: found.id, kind: found.kind, name: found.name, ...unlinkedFields(found.refs, connections), notes: found.notes.map(noteOf), links: await linksFor(ownerId, found.links, connections) };
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

/**
 * Account deletion, inside the caller's transaction: everything this person
 * kept, under either identity that can name them, and every other owner's
 * entity that knew this person only as an OpenChat account.
 */
export async function deletePrivateGraphForUser(tx: Runner, userId: string): Promise<void> {
  const identity = await tx.run('MATCH (user:User {id: $userId}) RETURN user.ideaflowIssuer AS issuer, user.ideaflowSub AS subject', { userId });
  const issuer = identity.records[0]?.get('issuer'), subject = identity.records[0]?.get('subject');
  const runner = tx as unknown as Parameters<typeof deleteOwnerIn>[0];
  await deleteOwnerIn(runner, fallbackKey(userId));
  if (typeof issuer === 'string' && issuer && typeof subject === 'string' && subject) await deleteOwnerIn(runner, ownerKeyFor(issuer, subject));
  const ownerKeys = [fallbackKey(userId)];
  if (typeof issuer === 'string' && issuer && typeof subject === 'string' && subject) ownerKeys.push(ownerKeyFor(issuer, subject));
  for (const label of ['OpenChatNoteReview', 'OpenChatPrivateAsk']) {
    await tx.run(`MATCH (n:${label}) WHERE n.ownerKey IN $ownerKeys DETACH DELETE n`, { ownerKeys });
    await tx.run(`MATCH (n:${label}), (r:OverlayRef {ref:$ref})-[:REF_OF]->(e:OverlayEntity {id:n.entityId,ownerKey:n.ownerKey})
      WHERE NOT EXISTS { MATCH (other:OverlayRef)-[:REF_OF]->(e) WHERE other.ref <> $ref } DETACH DELETE n`, { ref: userRef(userId) });
  }
  await purgeRefIn(runner, userRef(userId));
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
