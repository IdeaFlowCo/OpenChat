/**
 * Private graph — a person's own notes and links about the people they know.
 *
 * Everything here belongs to one owner and is returned only to that owner:
 *
 *   :OpenChatPersonCard  { key, ownerId, subjectId, important, cadenceDays,
 *                          cadenceMode, intervalDays, lastContactAt }
 *   :OpenChatPrivateNote { id, ownerId, subjectKind, subjectId, text }
 *   :OpenChatThing       { id, ownerId, kind, name, nameKey }   person | company | idea | project
 *   :OpenChatPrivateLink { id, ownerId, fromKind, fromId, relation, toKind, toId }
 *
 * A link also carries real LINK_FROM / LINK_TO relationships to its endpoints,
 * so the overlay is traversable in the shared graph. The person a note or link
 * is about never sees it, and nothing here is read by search, matching or
 * other people's profiles.
 */

import { nanoid } from 'nanoid';
import neo4j from 'neo4j-driver';
import { getDriver } from '../db.js';
import { DEFAULT_PUBLIC_DISPLAY_NAME } from '../privacy/profilePrivacy.js';

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

const iso = (value: unknown): string => typeof value === 'string' ? value : '';
const noteFrom = (value: Record<string, unknown>): PrivateNote => ({ id: String(value.id), text: String(value.text), createdAt: iso(value.createdAt), updatedAt: iso(value.updatedAt) });

type Runner = { run: (query: string, parameters?: Record<string, unknown>) => Promise<{ records: Array<{ get: (key: string) => unknown }> }> };

/** The other person must exist, be a person, and have no block in either direction. */
async function assertPerson(tx: Runner, ownerId: string, userId: string): Promise<PersonBasics> {
  if (ownerId === userId) fail(400, 'This card is for other people');
  const result = await tx.run(`
    MATCH (owner:User {id: $ownerId}), (subject:User {id: $userId})
    RETURN coalesce(subject.isBot, false) AS isBot,
      ((owner)-[:BLOCKED]->(subject) OR (subject)-[:BLOCKED]->(owner)) AS blocked,
      coalesce(subject.name, 'Unknown') AS name, subject.avatarUrl AS avatarUrl
  `, { ownerId, userId });
  const record = result.records[0];
  if (!record || record.get('isBot') === true || record.get('blocked') === true) return fail(404, 'Person unavailable');
  return { id: userId, name: String(record.get('name')), avatarUrl: (record.get('avatarUrl') as string | null) ?? null };
}

const cardKey = (ownerId: string, userId: string) => JSON.stringify([ownerId, userId]);

const linksQuery = `
  MATCH (link:OpenChatPrivateLink {ownerId: $ownerId})
  WHERE (link.fromKind = $kind AND link.fromId = $id) OR (link.toKind = $kind AND link.toId = $id)
  WITH link, CASE WHEN link.fromKind = $kind AND link.fromId = $id THEN 'out' ELSE 'in' END AS direction
  WITH link, direction,
    CASE direction WHEN 'out' THEN link.toKind ELSE link.fromKind END AS otherKind,
    CASE direction WHEN 'out' THEN link.toId ELSE link.fromId END AS otherId
  OPTIONAL MATCH (user:User {id: otherId}) WHERE otherKind = 'user'
  OPTIONAL MATCH (thing:OpenChatThing {id: otherId, ownerId: $ownerId}) WHERE otherKind <> 'user'
  RETURN link.id AS id, link.relation AS relation, direction, otherKind, otherId,
    CASE WHEN otherKind = 'user'
      THEN CASE WHEN user.name IS NULL OR trim(user.name) = '' OR user.name CONTAINS '@' THEN $fallbackName ELSE user.name END
      ELSE thing.name END AS otherName,
    toString(link.createdAt) AS createdAt
  ORDER BY link.createdAt DESC
  LIMIT 500
`;

async function readLinks(tx: Runner, ownerId: string, kind: NodeKind, id: string): Promise<PrivateLink[]> {
  const result = await tx.run(linksQuery, { ownerId, kind, id, fallbackName: DEFAULT_PUBLIC_DISPLAY_NAME });
  return result.records.filter(record => record.get('otherName') !== null).map(record => ({
    id: String(record.get('id')), relation: String(record.get('relation')), direction: record.get('direction') as 'out' | 'in',
    other: { kind: record.get('otherKind') as NodeKind, id: String(record.get('otherId')), name: String(record.get('otherName')) },
    createdAt: iso(record.get('createdAt')),
  }));
}

async function readNotes(tx: Runner, ownerId: string, subjectKind: NodeKind, subjectId: string): Promise<PrivateNote[]> {
  const result = await tx.run(`
    MATCH (note:OpenChatPrivateNote {ownerId: $ownerId, subjectKind: $subjectKind, subjectId: $subjectId})
    RETURN note { .id, .text, createdAt: toString(note.createdAt), updatedAt: toString(note.updatedAt) } AS note
    ORDER BY note.createdAt DESC LIMIT $limit
  `, { ownerId, subjectKind, subjectId, limit: neoInt(LIMITS.notesPerSubject) });
  return result.records.map(record => noteFrom(record.get('note') as Record<string, unknown>));
}

// neo4j-driver sends JS numbers as floats; LIMIT needs an integer.
const neoInt = (value: number) => neo4j.int(value);
const num = (value: unknown): number | null => value === null || value === undefined ? null : typeof value === 'number' ? value : typeof (value as { toNumber?: () => number }).toNumber === 'function' ? (value as { toNumber: () => number }).toNumber() : Number(value);

function cardFrom(value: Record<string, unknown> | null): PersonCard {
  if (!value) return { ...EMPTY_CARD };
  const card = {
    important: value.important === true,
    cadenceDays: num(value.cadenceDays),
    cadenceMode: value.cadenceMode === 'expanding' ? 'expanding' as const : 'fixed' as const,
    intervalDays: num(value.intervalDays),
    lastContactAt: iso(value.lastContactAt) || null,
  };
  return { ...card, nextDueAt: nextDue(card, iso(value.cadenceSetAt) || iso(value.createdAt)) };
}

const cardProjection = 'card { .important, .cadenceDays, .cadenceMode, .intervalDays, lastContactAt: toString(card.lastContactAt), cadenceSetAt: toString(card.cadenceSetAt), createdAt: toString(card.createdAt) }';

export async function getPersonOverlay(ownerId: string, userId: string): Promise<PersonOverlay> {
  const session = getDriver().session();
  try {
    return await session.executeRead(async tx => {
      // Name and picture ride along so the card can open for someone who shares no chat with the owner.
      const person = await assertPerson(tx, ownerId, userId);
      const result = await tx.run(`OPTIONAL MATCH (card:OpenChatPersonCard {key: $key}) RETURN ${cardProjection} AS card`, { key: cardKey(ownerId, userId) });
      return {
        userId, person, card: cardFrom(result.records[0]?.get('card') as Record<string, unknown> | null),
        notes: await readNotes(tx, ownerId, 'user', userId), links: await readLinks(tx, ownerId, 'user', userId),
      };
    });
  } finally { await session.close(); }
}

export async function updatePersonCard(ownerId: string, userId: string, patch: CardPatch): Promise<PersonCard> {
  const session = getDriver().session();
  try {
    return await session.executeWrite(async tx => {
      await assertPerson(tx, ownerId, userId);
      const key = cardKey(ownerId, userId), now = new Date().toISOString();
      const existing = await tx.run(`OPTIONAL MATCH (card:OpenChatPersonCard {key: $key}) RETURN ${cardProjection} AS card`, { key });
      const current = cardFrom(existing.records[0]?.get('card') as Record<string, unknown> | null);
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
      const written = await tx.run(`
        MATCH (owner:User {id: $ownerId}), (subject:User {id: $userId})
        MERGE (card:OpenChatPersonCard {key: $key})
        ON CREATE SET card.ownerId = $ownerId, card.subjectId = $userId, card.createdAt = datetime($now)
        SET card.important = $important, card.cadenceDays = $cadenceDays, card.cadenceMode = $cadenceMode,
            card.intervalDays = $intervalDays, card.updatedAt = datetime($now),
            card.lastContactAt = CASE WHEN $lastContactAt IS NULL THEN null ELSE datetime($lastContactAt) END,
            card.cadenceSetAt = CASE WHEN $cadenceChanged OR card.cadenceSetAt IS NULL THEN datetime($now) ELSE card.cadenceSetAt END
        MERGE (owner)-[:HAS_PERSON_CARD]->(card)
        MERGE (card)-[:CARD_ABOUT]->(subject)
        RETURN ${cardProjection} AS card
      `, { ownerId, userId, key, now, important: next.important, cadenceDays: next.cadenceDays === null ? null : neoInt(next.cadenceDays), cadenceMode: next.cadenceMode, intervalDays: next.intervalDays === null ? null : neoInt(next.intervalDays), lastContactAt: next.lastContactAt, cadenceChanged });
      return cardFrom(written.records[0]?.get('card') as Record<string, unknown>);
    });
  } finally { await session.close(); }
}

async function ownedThing(tx: Runner, ownerId: string, id: string): Promise<Thing> {
  const result = await tx.run('MATCH (thing:OpenChatThing {id: $id, ownerId: $ownerId}) RETURN thing { .id, .kind, .name } AS thing', { id, ownerId });
  const thing = result.records[0]?.get('thing') as Thing | undefined;
  return thing ?? fail(404, 'Not found');
}

async function assertSubject(tx: Runner, ownerId: string, kind: NodeKind, id: string): Promise<void> {
  if (kind === 'user') await assertPerson(tx, ownerId, id);
  else await ownedThing(tx, ownerId, id);
}

export async function addNote(ownerId: string, subject: { kind: 'user' | 'thing'; id: string }, rawText: unknown): Promise<PrivateNote> {
  const text = cleanText(rawText, LIMITS.noteLength, 'Note');
  const session = getDriver().session();
  try {
    return await session.executeWrite(async tx => {
      const subjectKind: NodeKind = subject.kind === 'user' ? 'user' : (await ownedThing(tx, ownerId, subject.id)).kind;
      if (subject.kind === 'user') await assertPerson(tx, ownerId, subject.id);
      const count = await tx.run('MATCH (note:OpenChatPrivateNote {ownerId: $ownerId, subjectKind: $subjectKind, subjectId: $subjectId}) RETURN count(note) AS total', { ownerId, subjectKind, subjectId: subject.id });
      if ((num(count.records[0]?.get('total')) ?? 0) >= LIMITS.notesPerSubject) fail(409, 'This card has reached its note limit');
      const result = await tx.run(`
        MATCH (owner:User {id: $ownerId})
        CREATE (note:OpenChatPrivateNote {id: $id, ownerId: $ownerId, subjectKind: $subjectKind, subjectId: $subjectId, text: $text, createdAt: datetime($now), updatedAt: datetime($now)})
        CREATE (owner)-[:WROTE_PRIVATE_NOTE]->(note)
        WITH note
        OPTIONAL MATCH (user:User {id: $subjectId}) WHERE $subjectKind = 'user'
        OPTIONAL MATCH (thing:OpenChatThing {id: $subjectId, ownerId: $ownerId}) WHERE $subjectKind <> 'user'
        FOREACH (target IN CASE WHEN user IS NULL THEN [] ELSE [user] END | CREATE (note)-[:NOTE_ABOUT]->(target))
        FOREACH (target IN CASE WHEN thing IS NULL THEN [] ELSE [thing] END | CREATE (note)-[:NOTE_ABOUT]->(target))
        RETURN note { .id, .text, createdAt: toString(note.createdAt), updatedAt: toString(note.updatedAt) } AS note
      `, { ownerId, id: nanoid(), subjectKind, subjectId: subject.id, text, now: new Date().toISOString() });
      return noteFrom(result.records[0]!.get('note') as Record<string, unknown>);
    });
  } finally { await session.close(); }
}

export async function updateNote(ownerId: string, noteId: string, rawText: unknown): Promise<PrivateNote> {
  const text = cleanText(rawText, LIMITS.noteLength, 'Note');
  const session = getDriver().session();
  try {
    const result = await session.run(`
      MATCH (note:OpenChatPrivateNote {id: $noteId, ownerId: $ownerId})
      SET note.text = $text, note.updatedAt = datetime($now)
      RETURN note { .id, .text, createdAt: toString(note.createdAt), updatedAt: toString(note.updatedAt) } AS note
    `, { ownerId, noteId, text, now: new Date().toISOString() });
    const note = result.records[0]?.get('note') as Record<string, unknown> | undefined;
    return note ? noteFrom(note) : fail(404, 'Note not found');
  } finally { await session.close(); }
}

export async function deleteNote(ownerId: string, noteId: string): Promise<{ deleted: true }> {
  const session = getDriver().session();
  try {
    const result = await session.run('MATCH (note:OpenChatPrivateNote {id: $noteId, ownerId: $ownerId}) DETACH DELETE note RETURN count(*) AS removed', { ownerId, noteId });
    if (!num(result.records[0]?.get('removed'))) fail(404, 'Note not found');
    return { deleted: true };
  } finally { await session.close(); }
}

async function resolveTarget(tx: Runner, ownerId: string, target: LinkTarget): Promise<LinkEnd> {
  if (target.kind === 'user') {
    await assertPerson(tx, ownerId, target.id);
    return { kind: 'user', id: target.id, name: '' };
  }
  if (target.id) {
    const thing = await ownedThing(tx, ownerId, target.id);
    if (thing.kind !== target.kind) fail(400, 'That item is a different kind');
    return thing;
  }
  const name = target.name!, key = nameKey(name);
  const existing = await tx.run('MATCH (thing:OpenChatThing {ownerId: $ownerId, kind: $kind, nameKey: $nameKey}) RETURN thing { .id, .kind, .name } AS thing', { ownerId, kind: target.kind, nameKey: key });
  const found = existing.records[0]?.get('thing') as Thing | undefined;
  if (found) return found;
  const count = await tx.run('MATCH (thing:OpenChatThing {ownerId: $ownerId}) RETURN count(thing) AS total', { ownerId });
  if ((num(count.records[0]?.get('total')) ?? 0) >= LIMITS.thingsPerOwner) fail(409, 'You have reached the limit for saved items');
  const created = await tx.run(`
    MATCH (owner:User {id: $ownerId})
    CREATE (thing:OpenChatThing {id: $id, ownerId: $ownerId, kind: $kind, name: $name, nameKey: $nameKey, thingKey: $thingKey, createdAt: datetime($now)})
    CREATE (owner)-[:HAS_PRIVATE_THING]->(thing)
    RETURN thing { .id, .kind, .name } AS thing
  `, { ownerId, id: nanoid(), kind: target.kind, name, nameKey: key, thingKey: JSON.stringify([ownerId, target.kind, key]), now: new Date().toISOString() });
  return created.records[0]!.get('thing') as Thing;
}

/** Link a person or one of your saved items to another person, company, idea or project. */
export async function addLink(ownerId: string, from: { kind: 'user' | 'thing'; id: string }, rawRelation: unknown, rawTarget: unknown): Promise<PrivateLink> {
  const relation = cleanRelation(rawRelation), target = parseLinkTarget(rawTarget);
  const session = getDriver().session();
  try {
    return await session.executeWrite(async tx => {
      const fromKind: NodeKind = from.kind === 'user' ? 'user' : (await ownedThing(tx, ownerId, from.id)).kind;
      await assertSubject(tx, ownerId, fromKind, from.id);
      const to = await resolveTarget(tx, ownerId, target);
      if (to.kind === fromKind && to.id === from.id) fail(400, 'Choose something else to link to');
      const linkKey = JSON.stringify([ownerId, fromKind, from.id, relation, to.kind, to.id]);
      const count = await tx.run('MATCH (link:OpenChatPrivateLink {ownerId: $ownerId}) RETURN count(link) AS total', { ownerId });
      if ((num(count.records[0]?.get('total')) ?? 0) >= LIMITS.linksPerOwner) fail(409, 'You have reached the limit for links');
      await tx.run(`
        MATCH (owner:User {id: $ownerId})
        MERGE (link:OpenChatPrivateLink {linkKey: $linkKey})
        ON CREATE SET link.id = $id, link.ownerId = $ownerId, link.fromKind = $fromKind, link.fromId = $fromId,
          link.relation = $relation, link.toKind = $toKind, link.toId = $toId, link.createdAt = datetime($now)
        MERGE (owner)-[:HAS_PRIVATE_LINK]->(link)
        WITH link
        OPTIONAL MATCH (fromUser:User {id: $fromId}) WHERE $fromKind = 'user'
        OPTIONAL MATCH (fromThing:OpenChatThing {id: $fromId, ownerId: $ownerId}) WHERE $fromKind <> 'user'
        OPTIONAL MATCH (toUser:User {id: $toId}) WHERE $toKind = 'user'
        OPTIONAL MATCH (toThing:OpenChatThing {id: $toId, ownerId: $ownerId}) WHERE $toKind <> 'user'
        FOREACH (node IN CASE WHEN fromUser IS NULL THEN [] ELSE [fromUser] END | MERGE (link)-[:LINK_FROM]->(node))
        FOREACH (node IN CASE WHEN fromThing IS NULL THEN [] ELSE [fromThing] END | MERGE (link)-[:LINK_FROM]->(node))
        FOREACH (node IN CASE WHEN toUser IS NULL THEN [] ELSE [toUser] END | MERGE (link)-[:LINK_TO]->(node))
        FOREACH (node IN CASE WHEN toThing IS NULL THEN [] ELSE [toThing] END | MERGE (link)-[:LINK_TO]->(node))
      `, { ownerId, linkKey, id: nanoid(), fromKind, fromId: from.id, relation, toKind: to.kind, toId: to.id, now: new Date().toISOString() });
      const links = await readLinks(tx, ownerId, fromKind, from.id);
      const link = links.find(value => value.direction === 'out' && value.relation === relation && value.other.kind === to.kind && value.other.id === to.id);
      return link ?? fail(500, 'Link could not be saved');
    });
  } finally { await session.close(); }
}

export async function deleteLink(ownerId: string, linkId: string): Promise<{ deleted: true }> {
  const session = getDriver().session();
  try {
    const result = await session.run('MATCH (link:OpenChatPrivateLink {id: $linkId, ownerId: $ownerId}) DETACH DELETE link RETURN count(*) AS removed', { ownerId, linkId });
    if (!num(result.records[0]?.get('removed'))) fail(404, 'Link not found');
    return { deleted: true };
  } finally { await session.close(); }
}

export async function listThings(ownerId: string, query: unknown, kind: unknown): Promise<{ things: Thing[] }> {
  const q = typeof query === 'string' ? nameKey(query).slice(0, LIMITS.nameLength) : '';
  if (kind !== undefined && !THING_KINDS.includes(kind as ThingKind)) fail(400, 'Unknown kind');
  const session = getDriver().session();
  try {
    const result = await session.run(`
      MATCH (thing:OpenChatThing {ownerId: $ownerId})
      WHERE ($kind IS NULL OR thing.kind = $kind) AND ($q = '' OR thing.nameKey CONTAINS $q)
      RETURN thing { .id, .kind, .name } AS thing
      ORDER BY thing.nameKey LIMIT 50
    `, { ownerId, q, kind: kind ?? null });
    return { things: result.records.map(record => record.get('thing') as Thing) };
  } finally { await session.close(); }
}

export async function getThing(ownerId: string, thingId: string): Promise<ThingDetail> {
  const session = getDriver().session();
  try {
    return await session.executeRead(async tx => {
      const thing = await ownedThing(tx, ownerId, thingId);
      return { ...thing, notes: await readNotes(tx, ownerId, thing.kind, thing.id), links: await readLinks(tx, ownerId, thing.kind, thing.id) };
    });
  } finally { await session.close(); }
}

/** People whose catch-up date has passed, soonest first; starred people lead ties. */
export async function listDue(ownerId: string, now = new Date()): Promise<{ due: DuePerson[] }> {
  const session = getDriver().session();
  try {
    const result = await session.run(`
      MATCH (owner:User {id: $ownerId})-[:HAS_PERSON_CARD]->(card:OpenChatPersonCard)-[:CARD_ABOUT]->(subject:User)
      WHERE card.cadenceDays IS NOT NULL AND NOT (owner)-[:BLOCKED]->(subject) AND NOT (subject)-[:BLOCKED]->(owner)
      RETURN subject.id AS userId,
        CASE WHEN subject.name IS NULL OR trim(subject.name) = '' OR subject.name CONTAINS '@' THEN $fallbackName ELSE subject.name END AS name,
        subject.avatarUrl AS avatarUrl, ${cardProjection} AS card
      LIMIT 2000
    `, { ownerId, fallbackName: DEFAULT_PUBLIC_DISPLAY_NAME });
    const due = result.records.map(record => {
      const card = cardFrom(record.get('card') as Record<string, unknown>);
      return { userId: String(record.get('userId')), name: String(record.get('name')), avatarUrl: (record.get('avatarUrl') as string | null) ?? null, important: card.important, nextDueAt: card.nextDueAt, lastContactAt: card.lastContactAt };
    }).filter((value): value is DuePerson => value.nextDueAt !== null && Date.parse(value.nextDueAt) <= now.getTime());
    due.sort((a, b) => Date.parse(a.nextDueAt) - Date.parse(b.nextDueAt) || Number(b.important) - Number(a.important) || a.name.localeCompare(b.name));
    return { due };
  } finally { await session.close(); }
}

/**
 * Account deletion: remove everything this person wrote, and every card, note
 * and link other people keep about them. Runs inside the caller's transaction.
 */
export async function deletePrivateGraphForUser(tx: Runner, userId: string): Promise<void> {
  for (const label of ['OpenChatPersonCard', 'OpenChatPrivateNote', 'OpenChatPrivateLink', 'OpenChatThing']) {
    await tx.run(`MATCH (owned:${label} {ownerId: $userId}) DETACH DELETE owned`, { userId });
  }
  await tx.run('MATCH (card:OpenChatPersonCard {subjectId: $userId}) DETACH DELETE card', { userId });
  await tx.run("MATCH (note:OpenChatPrivateNote {subjectKind: 'user', subjectId: $userId}) DETACH DELETE note", { userId });
  // Two statements so each can use its own index; an OR across both ends cannot.
  await tx.run("MATCH (link:OpenChatPrivateLink {fromKind: 'user', fromId: $userId}) DETACH DELETE link", { userId });
  await tx.run("MATCH (link:OpenChatPrivateLink {toKind: 'user', toId: $userId}) DETACH DELETE link", { userId });
}

/** Account export: the owner's whole private graph, as plain rows. */
export async function exportPrivateGraph(userId: string): Promise<{ cards: unknown[]; notes: unknown[]; things: unknown[]; links: unknown[] }> {
  const session = getDriver().session();
  try {
    const rows = async (query: string) => (await session.run(query, { userId })).records.map(record => record.get('row'));
    return {
      cards: await rows('MATCH (card:OpenChatPersonCard {ownerId: $userId}) RETURN card { .subjectId, .important, .cadenceDays, .cadenceMode, .intervalDays, lastContactAt: toString(card.lastContactAt), createdAt: toString(card.createdAt), updatedAt: toString(card.updatedAt) } AS row ORDER BY card.createdAt'),
      notes: await rows('MATCH (note:OpenChatPrivateNote {ownerId: $userId}) RETURN note { .id, .subjectKind, .subjectId, .text, createdAt: toString(note.createdAt), updatedAt: toString(note.updatedAt) } AS row ORDER BY note.createdAt'),
      things: await rows('MATCH (thing:OpenChatThing {ownerId: $userId}) RETURN thing { .id, .kind, .name, createdAt: toString(thing.createdAt) } AS row ORDER BY thing.createdAt'),
      links: await rows('MATCH (link:OpenChatPrivateLink {ownerId: $userId}) RETURN link { .id, .fromKind, .fromId, .relation, .toKind, .toId, createdAt: toString(link.createdAt) } AS row ORDER BY link.createdAt'),
    };
  } finally { await session.close(); }
}

export async function ensurePrivateGraphIndexes(): Promise<void> {
  const session = getDriver().session();
  try {
    for (const statement of [
      'CREATE CONSTRAINT openchat_person_card_key IF NOT EXISTS FOR (card:OpenChatPersonCard) REQUIRE card.key IS UNIQUE',
      'CREATE CONSTRAINT openchat_private_note_id IF NOT EXISTS FOR (note:OpenChatPrivateNote) REQUIRE note.id IS UNIQUE',
      'CREATE CONSTRAINT openchat_thing_id IF NOT EXISTS FOR (thing:OpenChatThing) REQUIRE thing.id IS UNIQUE',
      'CREATE CONSTRAINT openchat_thing_key IF NOT EXISTS FOR (thing:OpenChatThing) REQUIRE thing.thingKey IS UNIQUE',
      'CREATE CONSTRAINT openchat_private_link_key IF NOT EXISTS FOR (link:OpenChatPrivateLink) REQUIRE link.linkKey IS UNIQUE',
      'CREATE INDEX openchat_person_card_owner IF NOT EXISTS FOR (card:OpenChatPersonCard) ON (card.ownerId)',
      'CREATE INDEX openchat_person_card_subject IF NOT EXISTS FOR (card:OpenChatPersonCard) ON (card.subjectId)',
      'CREATE INDEX openchat_private_note_subject IF NOT EXISTS FOR (note:OpenChatPrivateNote) ON (note.ownerId, note.subjectKind, note.subjectId)',
      'CREATE INDEX openchat_thing_owner IF NOT EXISTS FOR (thing:OpenChatThing) ON (thing.ownerId, thing.kind, thing.nameKey)',
      'CREATE INDEX openchat_private_link_owner IF NOT EXISTS FOR (link:OpenChatPrivateLink) ON (link.ownerId)',
      'CREATE INDEX openchat_private_link_id IF NOT EXISTS FOR (link:OpenChatPrivateLink) ON (link.id)',
      // Account deletion looks up what others wrote about the leaving person; without these it scans every note and link.
      'CREATE INDEX openchat_private_note_about IF NOT EXISTS FOR (note:OpenChatPrivateNote) ON (note.subjectKind, note.subjectId)',
      'CREATE INDEX openchat_private_link_from IF NOT EXISTS FOR (link:OpenChatPrivateLink) ON (link.fromKind, link.fromId)',
      'CREATE INDEX openchat_private_link_to IF NOT EXISTS FOR (link:OpenChatPrivateLink) ON (link.toKind, link.toId)',
    ]) await session.run(statement);
  } finally { await session.close(); }
}
