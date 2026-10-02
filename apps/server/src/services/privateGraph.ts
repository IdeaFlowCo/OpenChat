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

import { getDriver } from '../db.js';
import { DEFAULT_PUBLIC_DISPLAY_NAME } from '../privacy/profilePrivacy.js';
import { OverlayError, ownerKeyFor } from './overlay/contract.js';
import type { EntityDetail, Link as OverlayLink, OverlayPrincipal } from './overlay/contract.js';
import { deleteOwnerIn, OverlayStore, purgeRefIn } from './overlay/store.js';

export class PrivateGraphError extends Error {
  constructor(public status: number, message: string) { super(message); }
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
export interface LinkEnd { kind: NodeKind; id: string; name: string }
export interface PrivateLink { id: string; relation: string; direction: 'out' | 'in'; other: LinkEnd; createdAt: string }
export interface PersonBasics { id: string; name: string; avatarUrl: string | null }
export interface PersonOverlay { userId: string; person: PersonBasics; card: PersonCard; notes: PrivateNote[]; links: PrivateLink[] }
export interface Thing { id: string; kind: ThingKind; name: string }
export interface ThingDetail extends Thing { notes: PrivateNote[]; links: PrivateLink[] }
export interface DuePerson { userId: string; name: string; avatarUrl: string | null; important: boolean; nextDueAt: string; lastContactAt: string | null }

export const LIMITS = { noteLength: 4000, notesPerSubject: 200, linksPerOwner: 5000, thingsPerOwner: 5000, relationLength: 60, nameLength: 120, cadenceDays: 3650 } as const;
const EXPANDING_FACTOR = 1.6;
const EXPANDING_CEILING_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;
const EMPTY_CARD: PersonCard = { important: false, cadenceDays: null, cadenceMode: 'fixed', intervalDays: null, lastContactAt: null, nextDueAt: null };

const fail = (status: number, message: string): never => { throw new PrivateGraphError(status, message); };

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

export type LinkTarget = { kind: 'user'; id: string } | { kind: ThingKind; id?: string; name?: string };

export function parseLinkTarget(value: unknown): LinkTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(400, 'Choose what to link to');
  const input = value as Record<string, unknown>;
  if (input.kind === 'user') {
    if (typeof input.id !== 'string' || !input.id || input.id.length > 200) return fail(400, 'Choose a person');
    return { kind: 'user', id: input.id };
  }
  if (!THING_KINDS.includes(input.kind as ThingKind)) return fail(400, 'Choose a person, company, idea or project');
  if (typeof input.id === 'string' && input.id) {
    if (input.id.length > 64) return fail(400, 'Unknown item');
    return { kind: input.kind as ThingKind, id: input.id };
  }
  return { kind: input.kind as ThingKind, name: cleanText(input.name, LIMITS.nameLength, 'Name') };
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
    try { await (await store()).rekeyOwner(fallbackKey(ownerId), ownerKey); rekeyed.add(ownerId); }
    catch (error) {
      if (!(error instanceof OverlayError) || error.code !== 'owner_conflict') throw error;
      // Both identities already hold an overlay; joining them is a deliberate act, not done here.
      console.warn('Private graph: an overlay under the OpenChat identity was left in place because the Ideaflow identity already has one');
      rekeyed.add(ownerId);
    }
  }
  return { app: 'openchat', ownerKey };
}

async function ownerPrincipal(ownerId: string): Promise<OverlayPrincipal> {
  const session = getDriver().session();
  try {
    const result = await session.run('MATCH (owner:User {id: $ownerId}) RETURN owner.ideaflowIssuer AS issuer, owner.ideaflowSub AS subject', { ownerId });
    const record = result.records[0];
    if (!record) return fail(404, 'Not found');
    return principalFor(ownerId, record.get('issuer'), record.get('subject'));
  } finally { await session.close(); }
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
  return links.map(link => {
    const userId = userIdOf(link.other.refs);
    const other: LinkEnd = userId !== null
      ? { kind: 'user', id: userId, name: names.get(userId) ?? link.other.name }
      : { kind: link.other.kind, id: link.other.id, name: link.other.name };
    return { id: link.id, relation: link.relation, direction: link.direction, other, createdAt: link.createdAt };
  });
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

export async function addNote(ownerId: string, subject: { kind: 'user' | 'thing'; id: string }, rawText: unknown): Promise<PrivateNote> {
  const text = cleanText(rawText, LIMITS.noteLength, 'Note');
  if (subject.kind === 'user') {
    const { principal, entityId } = await personEntity(ownerId, subject.id);
    return overlayCall(overlay => overlay.addNote(principal, entityId, text));
  }
  const principal = await ownerPrincipal(ownerId);
  return overlayCall(overlay => overlay.addNote(principal, subject.id, text));
}

export async function updateNote(ownerId: string, noteId: string, rawText: unknown): Promise<PrivateNote> {
  const text = cleanText(rawText, LIMITS.noteLength, 'Note');
  const principal = await ownerPrincipal(ownerId);
  return overlayCall(overlay => overlay.updateNote(principal, noteId, text));
}

export async function deleteNote(ownerId: string, noteId: string): Promise<{ deleted: true }> {
  const principal = await ownerPrincipal(ownerId);
  await overlayCall(overlay => overlay.deleteNote(principal, noteId));
  return { deleted: true };
}

/** Link a person or one of your saved items to another person, company, idea or project. */
export async function addLink(ownerId: string, from: { kind: 'user' | 'thing'; id: string }, rawRelation: unknown, rawTarget: unknown): Promise<PrivateLink> {
  const relation = cleanRelation(rawRelation), target = parseLinkTarget(rawTarget);
  let principal: OverlayPrincipal, fromId: string;
  if (from.kind === 'user') ({ principal, entityId: fromId } = await personEntity(ownerId, from.id));
  else { principal = await ownerPrincipal(ownerId); fromId = from.id; }
  let toId: string;
  if (target.kind === 'user') toId = (await personEntity(ownerId, target.id)).entityId;
  else if (target.id) {
    const existing = await overlayCall(overlay => overlay.get(principal, target.id));
    if (existing.kind !== target.kind) fail(400, 'That item is a different kind');
    toId = existing.id;
  } else toId = (await overlayCall(overlay => overlay.ensure(principal, { kind: target.kind, name: target.name }))).entity.id;
  const link = await overlayCall(overlay => overlay.addLink(principal, fromId, relation, toId));
  return (await linksFor([link]))[0]!;
}

export async function deleteLink(ownerId: string, linkId: string): Promise<{ deleted: true }> {
  const principal = await ownerPrincipal(ownerId);
  await overlayCall(overlay => overlay.deleteLink(principal, linkId));
  return { deleted: true };
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
  return { id: found.id, kind: found.kind, name: found.name, notes: found.notes, links: await linksFor(found.links) };
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
  await purgeRefIn(runner, userRef(userId));
}

/** Account export: the owner's whole private graph, as plain rows. */
export async function exportPrivateGraph(userId: string): Promise<{ entities: unknown[]; notes: unknown[]; links: unknown[] }> {
  const principal = await ownerPrincipal(userId);
  return overlayCall(overlay => overlay.exportOwner(principal));
}

export async function ensurePrivateGraphIndexes(): Promise<void> {
  await store();
}
