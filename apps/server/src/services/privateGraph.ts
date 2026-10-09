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
 * blocks, not yourself), which identity names the owner, and the response
 * shapes the app and agent tools already use.
 */

import { createHash } from 'node:crypto';
import { getDriver } from '../db.js';
import { DEFAULT_PUBLIC_DISPLAY_NAME } from '../privacy/profilePrivacy.js';
import { OverlayError, ownerKeyFor } from './overlay/contract.js';
import type { EntityDetail, Link as OverlayLink, OverlayPrincipal } from './overlay/contract.js';
import { deleteOwnerIn, OverlayStore, purgeRefIn } from './overlay/store.js';
import { readUnlinkedProfileForIdentity } from './unlinkedProvision.js';

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
export interface PrivateNote { id: string; text: string; createdAt: string; updatedAt: string }
/** `unlinkedProfileId` is set when the end is an Unlinked profile (overlay ref `unlinked:person:<id>`); `id` is then its saved-thing id. */
export interface LinkEnd { kind: NodeKind; id: string; name: string; unlinkedProfileId?: string }
export interface PrivateLink { id: string; relation: string; direction: 'out' | 'in'; other: LinkEnd; createdAt: string }
export interface PersonBasics { id: string; name: string; avatarUrl: string | null }
export interface PersonOverlay { userId: string; person: PersonBasics; card: PersonCard; notes: PrivateNote[]; links: PrivateLink[] }
export interface Thing { id: string; kind: ThingKind; name: string }
export interface ThingDetail extends Thing { notes: PrivateNote[]; links: PrivateLink[]; unlinkedProfileId?: string }
export interface UnlinkedPersonOverlay { profileId: string; thingId: string | null; name: string | null; card: PersonCard; notes: PrivateNote[]; links: PrivateLink[] }
export interface OwnerLink { id: string; relation: string; from: LinkEnd; to: LinkEnd; createdAt: string }
/** Who a link or note is about: an OpenChat person, a saved thing, or an Unlinked profile. */
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
  if (typeof value !== 'string' || !UNLINKED_PROFILE_ID.test(value)) return fail(400, 'Use an Unlinked profile id from an Unlinked tool result');
  return value;
}

export function parseLinkTarget(value: unknown): LinkTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(400, 'Choose what to link to');
  const input = value as Record<string, unknown>;
  if (input.kind === 'user') {
    if (typeof input.id !== 'string' || !input.id || input.id.length > 200) return fail(400, 'Choose a person');
    return { kind: 'user', id: input.id };
  }
  if (input.kind === 'unlinked') return { kind: 'unlinked', id: cleanUnlinkedProfileId(input.id) };
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
};
/** Overlay refusals become the app's own wording; anything else stays an unexpected error. */
async function overlayCall<T>(work: (overlay: OverlayStore) => Promise<T>): Promise<T> {
  try { return await work(await store()); }
  catch (error) {
    if (error instanceof OverlayError && error.status < 500) fail(error.status, MESSAGES[error.code] ?? 'Check what you entered and try again');
    throw error;
  }
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
/** A person the owner deliberately kept apart from a same-named one; never an account. */
const SEPARATE_REF = 'openchat:private:';
const separateRef = (requestId: string) => `${SEPARATE_REF}${createHash('sha256').update(requestId).digest('hex').slice(0, 32)}`;

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
async function linksFor(links: OverlayLink[]): Promise<PrivateLink[]> {
  const userIds = [...new Set(links.map(link => userIdOf(link.other.refs)).filter((id): id is string => id !== null))];
  const names = new Map<string, string>();
  if (userIds.length) {
    const session = getDriver().session();
    try {
      const result = await session.run(`MATCH (subject:User) WHERE subject.id IN $userIds RETURN subject.id AS id, ${displayName} AS name`, { userIds, fallbackName: DEFAULT_PUBLIC_DISPLAY_NAME });
      for (const record of result.records) names.set(String(record.get('id')), String(record.get('name')));
    } finally { await session.close(); }
  }
  return links.map(link => ({ id: link.id, relation: link.relation, direction: link.direction, other: endOf(link.other, names), createdAt: link.createdAt }));
}
function endOf(entity: { id: string; kind: ThingKind; name: string; refs: string[] }, names: Map<string, string> = new Map()): LinkEnd {
  const userId = userIdOf(entity.refs);
  if (userId !== null) return { kind: 'user', id: userId, name: names.get(userId) ?? entity.name };
  const unlinkedProfileId = unlinkedIdOf(entity.refs);
  return { kind: entity.kind, id: entity.id, name: entity.name, ...(unlinkedProfileId !== null ? { unlinkedProfileId } : {}) };
}

/**
 * The entity for an Unlinked profile. An existing ref answers without asking
 * Unlinked (it was confirmed when first written); a new one is confirmed with
 * the owner's own read-only Unlinked grant, so only a published profile id
 * returned by Unlinked can become a private person here.
 */
async function unlinkedPersonEntity(ownerId: string, rawProfileId: string): Promise<{ principal: OverlayPrincipal; entityId: string }> {
  const profileId = cleanUnlinkedProfileId(rawProfileId);
  const { principal, identity } = await ownerContext(ownerId);
  const known = await overlayCall(overlay => overlay.lookup(principal, unlinkedRef(profileId)));
  if (known) return { principal, entityId: known.id };
  const result = await readUnlinkedProfileForIdentity(identity, profileId);
  if (!result.ok) {
    if (result.code === 'not_found') return fail(404, 'No published Unlinked profile has that id');
    if (result.code === 'not_linked') return fail(409, 'Sign in to Unlinked once with the same Ideaflow account to use Unlinked people here');
    if (result.code === 'grant_revoked' || result.code === 'scope_not_granted') return fail(409, 'Unlinked agent access is off for this account; turn it on in Unlinked Settings');
    return fail(503, 'Unlinked could not confirm that profile right now; retry');
  }
  const { entity } = await overlayCall(overlay => overlay.ensure(principal, { kind: 'person', name: result.profile.name, ref: unlinkedRef(result.profile.id) }));
  return { principal, entityId: entity.id };
}

/**
 * A saved thing named in a link. A name is reused only when it names exactly
 * one of the owner's saved things and nothing else of that kind shares it;
 * two people called Alex are never merged by name. Otherwise the caller gets
 * the candidates and picks one by id, or asks for a separate new entity.
 */
async function namedEntity(principal: OverlayPrincipal, target: { kind: ThingKind; name: string; createNew?: { requestId: string } }): Promise<string> {
  if (target.createNew) return (await overlayCall(overlay => overlay.ensure(principal, { kind: target.kind, name: target.name, ref: separateRef(target.createNew!.requestId) }))).entity.id;
  const session = getDriver().session();
  let matches: Array<{ id: string; name: string; refs: string[] }>;
  try {
    const result = await session.run(`MATCH (e:OverlayEntity {ownerKey: $ownerKey, kind: $kind, nameKey: $nameKey})
      RETURN e.id AS id, e.name AS name, [(r:OverlayRef)-[:REF_OF]->(e) | r.ref] AS refs ORDER BY e.createdAt LIMIT 20`,
    { ownerKey: principal.ownerKey, kind: target.kind, nameKey: nameKey(target.name) });
    matches = result.records.map(record => ({ id: String(record.get('id')), name: String(record.get('name')), refs: (record.get('refs') as string[]) ?? [] }));
  } finally { await session.close(); }
  if (matches.length === 1 && matches[0]!.refs.length === 0) return matches[0]!.id;
  if (!matches.length) return (await overlayCall(overlay => overlay.ensure(principal, { kind: target.kind, name: target.name }))).entity.id;
  const candidates = matches.map(match => {
    const end = endOf({ ...match, kind: target.kind });
    return { ...end, ...(end.kind === 'user' ? { use: { toKind: 'user', toId: end.id } } : end.unlinkedProfileId ? { use: { toKind: 'unlinked', toId: end.unlinkedProfileId } } : { use: { toKind: target.kind, toId: end.id } }) };
  });
  return fail(409, `More than one ${target.kind} is called ${target.name}. Choose one by id, or set createNew with a clientRequestId for a different one.`, { code: 'ambiguous_name', candidates });
}

/** The entity a note or link starts from. */
async function subjectEntity(ownerId: string, subject: Subject): Promise<{ principal: OverlayPrincipal; entityId: string }> {
  if (subject.kind === 'user') return personEntity(ownerId, subject.id);
  if (subject.kind === 'unlinked') return unlinkedPersonEntity(ownerId, subject.id);
  return { principal: await ownerPrincipal(ownerId), entityId: subject.id };
}

// ---- what the routes call ----

export async function getPersonOverlay(ownerId: string, userId: string): Promise<PersonOverlay> {
  // Reading never creates anything: a person nobody has written about has an empty card.
  const { person, principal } = await assertPerson(ownerId, userId);
  const found = await overlayCall(overlay => overlay.lookup(principal, userRef(userId)));
  return { userId, person, card: found?.card ?? { ...EMPTY_CARD }, notes: found?.notes ?? [], links: await linksFor(found?.links ?? []) };
}

export async function updatePersonCard(ownerId: string, userId: string, patch: CardPatch): Promise<PersonCard> {
  const { principal, entityId } = await personEntity(ownerId, userId);
  return (await overlayCall(overlay => overlay.update(principal, entityId, { card: patch }))).card;
}

export async function addNote(ownerId: string, subject: Subject, rawText: unknown): Promise<PrivateNote> {
  const text = cleanText(rawText, LIMITS.noteLength, 'Note');
  const { principal, entityId } = await subjectEntity(ownerId, subject);
  // The same text already on this card is the same note: a retried request never doubles it.
  const current = await overlayCall(overlay => overlay.get(principal, entityId));
  const existing = current.notes.find(note => note.text === text);
  if (existing) return existing;
  return overlayCall(overlay => overlay.addNote(principal, entityId, text));
}

export async function updateNote(ownerId: string, noteId: string, rawText: unknown): Promise<PrivateNote> {
  const text = cleanText(rawText, LIMITS.noteLength, 'Note');
  const principal = await ownerPrincipal(ownerId);
  return overlayCall(overlay => overlay.updateNote(principal, noteId, text));
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
      const result = await tx.run('MATCH (n:OverlayNote {id:$noteId,ownerKey:$ownerKey}) DETACH DELETE n RETURN count(*) AS removed', { noteId, ownerKey: principal.ownerKey });
      if (!Number(result.records[0]?.get('removed') ?? 0)) fail(404, 'Not found');
    });
  } finally { await db.close(); }
  return { deleted: true };
}

/** Link a person or one of your saved items to another person, company, idea or project. */
/**
 * Link a person, saved thing or Unlinked profile to another. The same subject,
 * relation and target is one link: repeating it returns the existing link.
 */
export async function addLink(ownerId: string, from: Subject, rawRelation: unknown, rawTarget: unknown): Promise<PrivateLink> {
  const relation = cleanRelation(rawRelation), target = parseLinkTarget(rawTarget);
  const { principal, entityId: fromId } = await subjectEntity(ownerId, from);
  let toId: string;
  if (target.kind === 'user') toId = (await personEntity(ownerId, target.id)).entityId;
  else if (target.kind === 'unlinked') toId = (await unlinkedPersonEntity(ownerId, target.id)).entityId;
  else if ('id' in target) {
    const existing = await overlayCall(overlay => overlay.get(principal, target.id));
    if (existing.kind !== target.kind) fail(400, 'That item is a different kind');
    toId = existing.id;
  } else toId = await namedEntity(principal, target);
  const link = await overlayCall(overlay => overlay.addLink(principal, fromId, relation, toId));
  return (await linksFor([link]))[0]!;
}

/** Read the owner's private card for an Unlinked profile. Never creates anything and never calls Unlinked. */
export async function getUnlinkedPersonOverlay(ownerId: string, rawProfileId: string): Promise<UnlinkedPersonOverlay> {
  const profileId = cleanUnlinkedProfileId(rawProfileId);
  const principal = await ownerPrincipal(ownerId);
  const found = await overlayCall(overlay => overlay.lookup(principal, unlinkedRef(profileId)));
  return { profileId, thingId: found?.id ?? null, name: found?.name ?? null, card: found?.card ?? { ...EMPTY_CARD }, notes: found?.notes ?? [], links: await linksFor(found?.links ?? []) };
}

/** Every private link the owner has recorded, newest first, optionally filtered by a name or relation. */
export async function listOwnerLinks(ownerId: string, rawQuery: unknown): Promise<{ links: OwnerLink[]; total: number }> {
  const query = typeof rawQuery === 'string' ? nameKey(rawQuery).slice(0, LIMITS.nameLength) : '';
  const principal = await ownerPrincipal(ownerId);
  const exported = await overlayCall(overlay => overlay.exportOwner(principal)) as { entities: Array<{ id: string; kind: ThingKind; name: string; refs: string[] }>; links: Array<{ id: string; fromId: string; relation: string; toId: string; createdAt: string }> };
  const entities = new Map(exported.entities.map(entity => [entity.id, entity]));
  const userIds = [...new Set(exported.entities.map(entity => userIdOf(entity.refs)).filter((id): id is string => id !== null))];
  const names = new Map<string, string>();
  if (userIds.length) {
    const session = getDriver().session();
    try {
      const result = await session.run(`MATCH (subject:User) WHERE subject.id IN $userIds RETURN subject.id AS id, ${displayName} AS name`, { userIds, fallbackName: DEFAULT_PUBLIC_DISPLAY_NAME });
      for (const record of result.records) names.set(String(record.get('id')), String(record.get('name')));
    } finally { await session.close(); }
  }
  const links = exported.links.flatMap(link => {
    const from = entities.get(link.fromId), to = entities.get(link.toId);
    return from && to ? [{ id: link.id, relation: link.relation, from: endOf(from, names), to: endOf(to, names), createdAt: link.createdAt }] : [];
  }).filter(link => !query || [link.relation, link.from.name, link.to.name].some(value => nameKey(value).includes(query)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  return { links: links.slice(0, 200), total: links.length };
}

export async function deleteLink(ownerId: string, linkId: string): Promise<{ deleted: true }> {
  const principal = await ownerPrincipal(ownerId);
  await overlayCall(overlay => overlay.deleteLink(principal, linkId));
  return { deleted: true };
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
  const unlinkedProfileId = unlinkedIdOf(found.refs);
  return { id: found.id, kind: found.kind, name: found.name, ...(unlinkedProfileId !== null ? { unlinkedProfileId } : {}), notes: found.notes, links: await linksFor(found.links) };
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
