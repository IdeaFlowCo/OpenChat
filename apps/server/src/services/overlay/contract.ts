/**
 * People overlay, version 1: one person's own notes, importance, catch-up
 * cadence and links about people, companies, ideas and projects.
 *
 * Deliberately owner-only. Nothing here grants anyone but the owner access;
 * `audience` is stored so a later team tier can widen it explicitly.
 * Apps (OpenChat, Unlinked) are views: they point at entities with refs such
 * as `openchat:user:<id>` or `unlinked:person:<id>`, and the same owner sees
 * the same overlay from either.
 *
 * This file and ./store.ts are the single owner of the overlay's semantics
 * (ambiguity, idempotency, provenance, relation types). OpenChat vendors both
 * byte-for-byte (apps/server/src/services/overlay/, checked by hash in its CI);
 * change them here first, then re-vendor.
 */
import { createHash } from 'node:crypto';

export const ENTITY_KINDS = ['person', 'company', 'idea', 'project'] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];
export type CadenceMode = 'fixed' | 'expanding';

export interface Card {
  important: boolean;
  cadenceDays: number | null;
  cadenceMode: CadenceMode;
  intervalDays: number | null;
  lastContactAt: string | null;
  nextDueAt: string | null;
}
export interface Entity { id: string; kind: EntityKind; name: string; refs: string[]; card: Card }

/**
 * Who wrote a note or link and how. All optional on storage: records written
 * before provenance existed read back with nulls. `author` is `owner` (the
 * owner themself, in an app) or `agent:<client name>`; `source` is how it
 * arrived; `assertion` is whether the owner stated it or it was inferred
 * (for example a model suggestion the owner applied).
 */
export const PROVENANCE_SOURCES = ['app', 'connector', 'direct-key', 'suggestion'] as const;
export type ProvenanceSource = (typeof PROVENANCE_SOURCES)[number];
export const ASSERTIONS = ['stated', 'inferred'] as const;
export type Assertion = (typeof ASSERTIONS)[number];
export interface Provenance { author: string | null; source: ProvenanceSource | null; assertion: Assertion | null }
/** What a write records when the caller says nothing: the owner, in an app, stating it. */
export const OWNER_PROVENANCE: Provenance = { author: 'owner', source: 'app', assertion: 'stated' };

/** A small canonical set, derived from the owner's free-text relation for querying. */
export const RELATION_TYPES = ['knows', 'family', 'works_at', 'worked_with', 'works_on', 'attended', 'interested_in', 'other'] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

export interface Note extends Provenance { id: string; text: string; createdAt: string; updatedAt: string }
export interface LinkEnd { id: string; kind: EntityKind; name: string; refs: string[] }
export interface Link extends Provenance { id: string; relation: string; relationType: RelationType; direction: 'out' | 'in'; other: LinkEnd; createdAt: string; updatedAt: string | null }
/** A link as an edge between two ends, for search and neighbourhood reads. */
export interface Edge extends Provenance { id: string; relation: string; relationType: RelationType; fromId: string; toId: string; createdAt: string; updatedAt: string | null }
export interface EntityDetail extends Entity { notes: Note[]; links: Link[] }
export interface SearchHit extends Entity { matched: Array<'name' | 'note' | 'link'> }
export interface SearchResult { entities: SearchHit[]; links: Array<Edge & { from: LinkEnd; to: LinkEnd }>; truncated: boolean }
export interface Neighbourhood { center: Entity; depth: 1 | 2; entities: Entity[]; links: Edge[]; truncated: boolean }
/** One of several same-named entities, offered back when a name alone is ambiguous. */
export interface Candidate { id: string; kind: EntityKind; name: string; refs: string[] }
export interface DueEntity { id: string; name: string; refs: string[]; important: boolean; nextDueAt: string; lastContactAt: string | null }
export interface CardPatch { important?: boolean; cadenceDays?: number | null; cadenceMode?: CadenceMode; contactedNow?: boolean }

/** A verified caller: which app is asking, and on behalf of which owner. */
export interface OverlayPrincipal { app: string; ownerKey: string }

export class OverlayError extends Error {
  /** `details` carries structured, owner-only extras such as `candidates` for `ambiguous_name`. */
  constructor(public readonly status: number, public readonly code: string, public readonly details?: Record<string, unknown>) { super(code); }
}
export const fail = (status: number, code: string, details?: Record<string, unknown>): never => { throw new OverlayError(status, code, details); };

export const LIMITS = {
  noteLength: 4000, notesPerEntity: 200, linksPerOwner: 5000, entitiesPerOwner: 5000,
  relationLength: 60, nameLength: 120, cadenceDays: 3650, refsPerEntity: 8,
} as const;
const EXPANDING_FACTOR = 1.6;
const EXPANDING_CEILING_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;
export const EMPTY_CARD: Card = { important: false, cadenceDays: null, cadenceMode: 'fixed', intervalDays: null, lastContactAt: null, nextDueAt: null };

/** The owner is an exact verified identity; emails and profile fields never name an owner. */
// eslint-disable-next-line no-control-regex -- an identity never contains control characters
const CONTROL = /[\x00-\x1f\x7f]/;
export function ownerKeyFor(issuer: string, subject: string): string {
  if (typeof issuer !== 'string' || !issuer || issuer.length > 2048 || typeof subject !== 'string' || !subject || subject.length > 512 ||
      CONTROL.test(issuer) || CONTROL.test(subject)) return fail(400, 'invalid_owner');
  return createHash('sha256').update(`${issuer}\n${subject}`).digest('hex');
}
export const isOwnerKey = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const isId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(value);

/**
 * `<app>:<type>:<value>`, for example `openchat:user:abc123`. A `linkedin:`
 * ref is only ever the hashed form (see `linkedinRef`): a plaintext LinkedIn
 * address is never stored in the overlay.
 */
export function cleanRef(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{1,30}:[a-z][a-z0-9-]{0,30}:[A-Za-z0-9._@%+-]{1,200}$/.test(value)) return fail(400, 'invalid_ref');
  if (value.startsWith('linkedin:') && !LINKEDIN_REF.test(value)) return fail(400, 'invalid_ref');
  return value;
}

/**
 * An imported LinkedIn contact: `linkedin:in:<sha256 hex of the canonical
 * slug>`. The slug is canonical as Unlinked defines it (`linkedinSlug()` in its
 * `src/utils/public-people/url-identity.mjs`: the `/in/<slug>` part, decoded
 * and lowercased); Unlinked's owner-scoped contact lookup returns the hash.
 * The ref survives re-import and later publication (the entity then also
 * carries `unlinked:person:<id>`); a changed vanity address is a new ref.
 * Which app may confirm one is the app's concern (OpenChat asks Unlinked).
 */
export const LINKEDIN_REF_PREFIX = 'linkedin:in:';
const LINKEDIN_REF = /^linkedin:in:[a-f0-9]{64}$/;
export function linkedinRef(hash: unknown): string {
  return typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash) ? `${LINKEDIN_REF_PREFIX}${hash}` : fail(400, 'invalid_ref');
}
/** The slug hash an entity's LinkedIn ref carries, or null. */
export const linkedinHashOf = (refs: string[]): string | null => {
  const ref = refs.find(value => LINKEDIN_REF.test(value));
  return ref ? ref.slice(LINKEDIN_REF_PREFIX.length) : null;
};

export function cleanText(value: unknown, max: number, code: string): string {
  if (typeof value !== 'string') return fail(400, code);
  // Control characters other than newline and tab never belong in a note or a name.
  // eslint-disable-next-line no-control-regex -- deliberate control-character strip
  const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (!text || text.length > max) return fail(400, code);
  return text;
}
export const nameKey = (name: string): string => name.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
export const cleanName = (value: unknown): string => cleanText(value, LIMITS.nameLength, 'invalid_name').replace(/\s+/g, ' ');
/** The relation is the owner's own words ("knows", "works at", "interested in"). */
export const cleanRelation = (value: unknown): string => cleanText(value, LIMITS.relationLength, 'invalid_relation').replace(/\s+/g, ' ').toLowerCase();
export function cleanKind(value: unknown): EntityKind {
  return ENTITY_KINDS.includes(value as EntityKind) ? value as EntityKind : fail(400, 'invalid_kind');
}

/** A retry key for a deliberately separate entity ("a different Alex"). */
export function cleanRequestId(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(value) ? value : fail(400, 'invalid_request_id');
}
/**
 * The ref of a deliberately separate entity: deterministic in the app and the
 * request id, so a retry finds the same entity. OpenChat's existing
 * `openchat:private:<hash>` refs are exactly this with app `openchat`.
 */
export const separateRef = (app: string, requestId: string): string =>
  cleanRef(`${app}:private:${createHash('sha256').update(cleanRequestId(requestId)).digest('hex').slice(0, 32)}`);

/**
 * Provenance a caller supplies. Missing fields take the owner defaults;
 * a supplied field must be valid. `agent:<name>` names the client, in the
 * name it registered with (1-80 printable characters).
 */
export function cleanProvenance(value: unknown): Provenance {
  if (value === undefined || value === null) return { ...OWNER_PROVENANCE };
  if (typeof value !== 'object' || Array.isArray(value)) return fail(400, 'invalid_provenance');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['author', 'source', 'assertion'].includes(key))) return fail(400, 'invalid_provenance');
  const result = { ...OWNER_PROVENANCE };
  if (input.author !== undefined) result.author = cleanAuthor(input.author);
  if (input.source !== undefined) {
    if (!PROVENANCE_SOURCES.includes(input.source as ProvenanceSource)) return fail(400, 'invalid_provenance');
    result.source = input.source as ProvenanceSource;
  }
  if (input.assertion !== undefined) {
    if (!ASSERTIONS.includes(input.assertion as Assertion)) return fail(400, 'invalid_provenance');
    result.assertion = input.assertion as Assertion;
  }
  return result;
}
export function cleanAuthor(value: unknown): string {
  if (value === 'owner') return value;
  if (typeof value !== 'string' || !value.startsWith('agent:')) return fail(400, 'invalid_provenance');
  // eslint-disable-next-line no-control-regex -- deliberate control-character strip
  const name = value.slice(6).replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return name && name.length <= 80 ? `agent:${name}` : fail(400, 'invalid_provenance');
}
/** Stored provenance as read back; anything absent or unrecognised is null (records from before provenance). */
export function readProvenance(value: { author?: unknown; source?: unknown; assertion?: unknown }): Provenance {
  return {
    author: typeof value.author === 'string' && value.author ? value.author : null,
    source: PROVENANCE_SOURCES.includes(value.source as ProvenanceSource) ? value.source as ProvenanceSource : null,
    assertion: ASSERTIONS.includes(value.assertion as Assertion) ? value.assertion as Assertion : null,
  };
}

/**
 * The canonical type of a free-text relation. Deterministic, so links stored
 * before relation types existed read back with the same type a new write
 * would get. First match wins; the order puts specific phrases first
 * ("worked with" before "works at", family words before "knows").
 */
const RELATION_PATTERNS: Array<[RelationType, RegExp]> = [
  ['family', /\b(sister|brother|sibling|twin|mother|father|mom|mum|dad|parent|son|daughter|child|kid|cousin|aunt|uncle|niece|nephew|grand(mother|father|parent|son|daughter|child|ma|pa)|grandma|grandpa|wife|husband|spouse|married|fianc[eé]e?|in-law|step(mother|father|sister|brother|son|daughter)|half-(sister|brother)|family|related to|relative)\b/],
  ['worked_with', /\b(work(s|ed|ing)? (together )?with|colleague|co-?worker|teammate|team ?mate|collaborat\w*|co-?founded with|used to work with)\b/],
  ['works_on', /\b(work(s|ed|ing)? on|build(s|ing)?|built|maintain(s|ed|er|ing)?|contribut\w*|lead(s|ing)? (the )?project|runs? (the )?project|creator of|author of)\b/],
  ['works_at', /\b(work(s|ed|ing)? (at|for)|employ\w*|job at|hired (at|by)|(ceo|cto|cfo|coo|cpo|vp|founder|co-?founder|cofounder|president|director|engineer|manager|intern|partner|advisor|investor|board member|staff|head|lead) (at|of)|founded|runs|joined)\b/],
  ['attended', /\b(attend(s|ed|ing)?|went to|goes to|stud(y|ies|ied|ying) at|alumn(us|a|i|ae)|graduat\w*|student at|class of|enrolled|school|college|university|classmate)\b/],
  ['interested_in', /\b(interest(s|ed)?|likes?|loves?|into|cares? about|passionate|fan of|curious about|excited about|follows|wants|cares)\b/],
  ['knows', /\b(knows?|knew|friends?|met|acquaint\w*|introduc\w*|mentor(s|ed|ing|ee)?|neighbou?r|roommate|room ?mate|housemate|connected|contact|close to|dated|dating|ex)\b/],
];
export function relationTypeOf(relation: string): RelationType {
  const text = relation.normalize('NFKC').toLowerCase().replace(/[_]+/g, ' ');
  for (const [type, pattern] of RELATION_PATTERNS) if (pattern.test(text)) return type;
  return 'other';
}
export function cleanRelationType(value: unknown): RelationType {
  return RELATION_TYPES.includes(value as RelationType) ? value as RelationType : fail(400, 'invalid_relation_type');
}

/**
 * When someone is next due. Fixed cadence repeats the same gap; expanding
 * cadence stretches the gap after each catch-up, the way spaced repetition
 * does, up to a year (never below the cadence the owner chose).
 */
export function nextDue(card: Pick<Card, 'cadenceDays' | 'intervalDays' | 'lastContactAt'>, anchor: string): string | null {
  const interval = card.intervalDays ?? card.cadenceDays;
  if (!interval) return null;
  const from = Date.parse(card.lastContactAt ?? anchor);
  return Number.isFinite(from) ? new Date(from + interval * DAY_MS).toISOString() : null;
}
export function intervalAfterContact(card: Pick<Card, 'cadenceDays' | 'cadenceMode' | 'intervalDays'>, hadPriorContact: boolean): number | null {
  if (!card.cadenceDays) return null;
  if (card.cadenceMode !== 'expanding' || !hadPriorContact) return card.intervalDays ?? card.cadenceDays;
  return Math.min(Math.max(EXPANDING_CEILING_DAYS, card.cadenceDays), Math.max(card.cadenceDays, Math.round((card.intervalDays ?? card.cadenceDays) * EXPANDING_FACTOR)));
}

export function parseCardPatch(body: unknown): CardPatch {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'invalid_card');
  const input = body as Record<string, unknown>, patch: CardPatch = {};
  if (Object.keys(input).some(key => !['important', 'cadenceDays', 'cadenceMode', 'contactedNow'].includes(key))) return fail(400, 'invalid_card');
  if ('important' in input) {
    if (typeof input.important !== 'boolean') return fail(400, 'invalid_card');
    patch.important = input.important;
  }
  if ('cadenceDays' in input) {
    const days = input.cadenceDays;
    if (days !== null && (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > LIMITS.cadenceDays)) return fail(400, 'invalid_card');
    patch.cadenceDays = days as number | null;
  }
  if ('cadenceMode' in input) {
    if (input.cadenceMode !== 'fixed' && input.cadenceMode !== 'expanding') return fail(400, 'invalid_card');
    patch.cadenceMode = input.cadenceMode;
  }
  if ('contactedNow' in input) {
    if (input.contactedNow !== true) return fail(400, 'invalid_card');
    patch.contactedNow = true;
  }
  if (!Object.keys(patch).length) return fail(400, 'invalid_card');
  return patch;
}
