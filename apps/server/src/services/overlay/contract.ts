/**
 * People overlay, version 1: one person's own notes, importance, catch-up
 * cadence and links about people, companies, ideas, projects and topics.
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

/**
 * `topic` is a thing in the world that people and projects are about (ADHD,
 * coherence, Neo4j); `idea` and `project` are things the owner might do.
 * `company` also covers schools and other organisations. `ask` (added
 * 2026-11-03) is a standing need or request, the owner's own or someone
 * else's ("Laurence wants a chiropractor in SF"); asks are saved and edited
 * only through the ask operations (`saveAsk`, `updateAsk`), never by name.
 */
export const ENTITY_KINDS = ['person', 'company', 'idea', 'project', 'topic', 'ask'] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];
/** The kinds saved, resolved and re-kinded by name: everything but `ask`. */
export const NAMED_KINDS = ['person', 'company', 'idea', 'project', 'topic'] as const;
export type NamedKind = (typeof NAMED_KINDS)[number];
export type CadenceMode = 'fixed' | 'expanding';

export interface Card {
  important: boolean;
  cadenceDays: number | null;
  cadenceMode: CadenceMode;
  intervalDays: number | null;
  lastContactAt: string | null;
  nextDueAt: string | null;
}
/**
 * `description` is a one-line summary (280 characters or fewer), null when none was given.
 * `ask` is present only on entities of kind `ask` (their ask fields, without the parties).
 */
export interface Entity { id: string; kind: EntityKind; name: string; description: string | null; refs: string[]; card: Card; ask?: AskFields }

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

/**
 * A small canonical set for querying; the owner's free-text `relation` stays
 * the label. `related` is the honest generic fallback ("connected to"); it
 * replaced `other`, which old links and old callers still use and which reads
 * back as `related`.
 */
export const RELATION_TYPES = ['knows', 'family', 'worked_with', 'works_at', 'works_on', 'attended', 'interested_in', 'part_of', 'about', 'asks', 'related'] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

export interface Note extends Provenance { id: string; text: string; createdAt: string; updatedAt: string }
export interface LinkEnd { id: string; kind: EntityKind; name: string; refs: string[] }
/**
 * Facts about a link besides its relation, all nullable: `since` and `until`
 * are free date text ("2019", "2024-03"), `context` how it came about ("met at
 * AGI House hackathon"). `updatedBy` is the author of the last edit, so an
 * edit never overwrites who first asserted the link.
 */
export interface LinkAttributes { since: string | null; until: string | null; context: string | null }
export interface Link extends Provenance, LinkAttributes { id: string; relation: string; relationType: RelationType; direction: 'out' | 'in'; other: LinkEnd; createdAt: string; updatedAt: string | null; updatedBy: string | null }
/** A link as an edge between two ends, for search and neighbourhood reads. */
export interface Edge extends Provenance, LinkAttributes { id: string; relation: string; relationType: RelationType; fromId: string; toId: string; createdAt: string; updatedAt: string | null; updatedBy: string | null }
export interface EntityDetail extends Entity { notes: Note[]; links: Link[] }
export interface SearchHit extends Entity { matched: Array<'name' | 'description' | 'note' | 'link'> }
export interface SearchResult { entities: SearchHit[]; links: Array<Edge & { from: LinkEnd; to: LinkEnd }>; truncated: boolean }
export interface Neighbourhood { center: Entity; depth: 1 | 2; entities: Entity[]; links: Edge[]; truncated: boolean }
/** One of several same-named entities, offered back when a name alone is ambiguous. */
export interface Candidate { id: string; kind: EntityKind; name: string; description: string | null; refs: string[] }
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
  descriptionLength: 280, contextLength: 280, dateTextLength: 20,
  askLength: 1000, asksPerOwner: 2000, quoteLength: 1000, urlLength: 2000, labelLength: 280, placementsPerAsk: 8,
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
/** Any kind, for filters (list, search). */
export function cleanKind(value: unknown): EntityKind {
  return ENTITY_KINDS.includes(value as EntityKind) ? value as EntityKind : fail(400, 'invalid_kind');
}
/** A kind saved by name (ensure, resolve, re-kind): an ask is saved only through `saveAsk`. */
export function cleanNamedKind(value: unknown): NamedKind {
  return NAMED_KINDS.includes(value as NamedKind) ? value as NamedKind : fail(400, 'invalid_kind');
}
/**
 * One optional line of free text: null, undefined or blank is "none";
 * whitespace (newlines included) collapses to single spaces.
 */
function cleanLine(value: unknown, max: number, code: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return fail(400, code);
  // eslint-disable-next-line no-control-regex -- deliberate control-character strip
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length > max) return fail(400, code);
  return text || null;
}
/** An entity's one-line summary ("a feed that nudges you into coherence"); null clears it. */
export const cleanDescription = (value: unknown): string | null => cleanLine(value, LIMITS.descriptionLength, 'invalid_description');

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
/** Whether a ref is only such a separate-entity ref (it names no app record, so the entity is the owner's own). */
export const isSeparateRef = (ref: string): boolean => /^[a-z][a-z0-9-]{1,30}:private:[a-f0-9]{32}$/.test(ref);

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
 * The canonical type of a free-text relation, given what it connects. A
 * caller-supplied type wins (see `cleanRelationType`); otherwise the first
 * pattern whose words match *and* whose ends fit applies, else `related`. So
 * "connected to" between two people is `knows`, but from an idea to a person
 * it is `related`. Ends are checked in either direction ("employs" and
 * "employed by" are both `works_at`). With no kinds given only the words
 * decide, among the original types; that is how links stored without a type
 * (before 2026-10-09) read, unchanged. The order puts specific phrases first
 * ("worked with" before "works at", family words before "knows").
 */
type Ends = Array<[readonly EntityKind[], readonly EntityKind[]]>;
const PEOPLE: Ends = [[['person'], ['person']]];
const RELATION_PATTERNS: Array<[RelationType, Ends | null, RegExp]> = [
  ['family', PEOPLE, /\b(sister|brother|sibling|twin|mother|father|mom|mum|dad|parent|son|daughter|child|kid|cousin|aunt|uncle|niece|nephew|grand(mother|father|parent|son|daughter|child|ma|pa)|grandma|grandpa|wife|husband|spouse|married|fianc[eé]e?|in-law|step(mother|father|sister|brother|son|daughter)|half-(sister|brother)|family|related to|relative)\b/],
  ['worked_with', PEOPLE, /\b(work(s|ed|ing)? (together )?with|colleague|co-?worker|teammate|team ?mate|collaborat\w*|co-?founded with|used to work with)\b/],
  ['works_on', [[['person', 'company'], ['project', 'idea']]], /\b(work(s|ed|ing)? on|build(s|ing)?|built|maintain(s|ed|er|ing)?|contribut\w*|lead(s|ing)? (the )?project|runs? (the )?project|creator of|author of)\b/],
  ['works_at', [[['person'], ['company']]], /\b(work(s|ed|ing)? (at|for)|employ\w*|job at|hired (at|by)|(ceo|cto|cfo|coo|cpo|vp|founder|co-?founder|cofounder|president|director|engineer|manager|intern|partner|advisor|investor|board member|staff|head|lead) (at|of)|founded|runs|joined)\b/],
  ['attended', [[['person'], ['company', 'topic']]], /\b(attend(s|ed|ing)?|went to|goes to|stud(y|ies|ied|ying) at|alumn(us|a|i|ae)|graduat\w*|student at|class of|enrolled|school|college|university|classmate)\b/],
  ['part_of', [[['project', 'idea', 'company'], ['project', 'company']]], /\b(part of|idea for|belongs? to|subsidiary of|division of|component of|feature of|module of|spin-?off of|sub-?project of|within|under)\b/],
  ['asks', [[['person', 'company', 'project', 'idea'], ['ask']]], /\b(asks?|asked|asking|needs?|needed|wants?|wanted|looking for|seeks?|seeking|requests?|requested)\b/],
  ['interested_in', [[['person'], ['topic', 'idea', 'project', 'company']]], /\b(interest(s|ed)?|likes?|loves?|into|cares? about|passionate|fan of|curious about|excited about|follows|wants|cares)\b/],
  ['about', [[['person', 'company', 'idea', 'project', 'topic', 'ask'], ['topic']]], /\b(about|has|had|have|tagged|topic|concerns?|regarding|re|diagnosed with|lives with|deals with|struggles with|focus(es|ed)? on|on)\b/],
  ['knows', PEOPLE, /\b(knows?|knew|friends?|met|acquaint\w*|introduc\w*|mentor(s|ed|ing|ee)?|neighbou?r|roommate|room ?mate|housemate|connected|contact|close to|dated|dating|ex)\b/],
];
/** Types added with end kinds (`part_of`, `about`, `asks`) need the kinds; without them only the original word patterns apply. */
const NEEDS_KINDS: readonly RelationType[] = ['part_of', 'about', 'asks'];
const endsFit = (type: RelationType, ends: Ends | null, from?: EntityKind, to?: EntityKind): boolean =>
  from === undefined || to === undefined ? !NEEDS_KINDS.includes(type)
    : !ends || ends.some(([a, b]) => (a.includes(from) && b.includes(to)) || (a.includes(to) && b.includes(from)));
export function relationTypeOf(relation: string, fromKind?: EntityKind, toKind?: EntityKind): RelationType {
  const text = relation.normalize('NFKC').toLowerCase().replace(/[_]+/g, ' ');
  for (const [type, ends, pattern] of RELATION_PATTERNS) if (endsFit(type, ends, fromKind, toKind) && pattern.test(text)) return type;
  return 'related';
}
/** A stored type as read back: the retired `other` is `related`; a missing or unknown one is derived from the words (and kinds, when given). */
export function readRelationType(stored: unknown, relation: string, fromKind?: EntityKind, toKind?: EntityKind): RelationType {
  if (stored === 'other') return 'related';
  return RELATION_TYPES.includes(stored as RelationType) ? stored as RelationType : relationTypeOf(relation, fromKind, toKind);
}
/** A caller-named relation type; the retired `other` is accepted as `related`. */
export function cleanRelationType(value: unknown): RelationType {
  if (value === 'other') return 'related';
  return RELATION_TYPES.includes(value as RelationType) ? value as RelationType : fail(400, 'invalid_relation_type');
}

/**
 * The attributes a caller may give a link, on add or edit. On add, absent
 * means none; on edit, absent leaves it and null clears it.
 */
export interface LinkAttributeInput { relationType?: RelationType | null; since?: string | null; until?: string | null; context?: string | null }
const LINK_ATTRIBUTE_KEYS = ['relationType', 'since', 'until', 'context'] as const;
export function cleanLinkAttributes(value: unknown): LinkAttributeInput {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) return fail(400, 'invalid_link');
  const input = value as Record<string, unknown>, result: LinkAttributeInput = {};
  if (Object.keys(input).some(key => !(LINK_ATTRIBUTE_KEYS as readonly string[]).includes(key))) return fail(400, 'invalid_link');
  if (input.relationType !== undefined) result.relationType = input.relationType === null || input.relationType === '' ? null : cleanRelationType(input.relationType);
  if (input.since !== undefined) result.since = cleanLine(input.since, LIMITS.dateTextLength, 'invalid_since');
  if (input.until !== undefined) result.until = cleanLine(input.until, LIMITS.dateTextLength, 'invalid_until');
  if (input.context !== undefined) result.context = cleanLine(input.context, LIMITS.contextLength, 'invalid_context');
  return result;
}

/**
 * An edit to a link (`PATCH /links/:id`). `relation` is part of the link's
 * identity; everything else is edited in place. `relationType: null` means
 * "derive it from the relation again".
 */
export interface LinkPatch extends LinkAttributeInput { relation?: string; assertion?: Assertion }
export function parseLinkPatch(value: unknown): LinkPatch {
  if (typeof value === 'string') return { relation: cleanRelation(value) };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(400, 'invalid_link');
  const { relation, assertion, ...attributes } = value as Record<string, unknown>;
  const patch: LinkPatch = cleanLinkAttributes(attributes);
  if (relation !== undefined) patch.relation = cleanRelation(relation);
  if (assertion !== undefined) {
    if (!ASSERTIONS.includes(assertion as Assertion)) return fail(400, 'invalid_provenance');
    patch.assertion = assertion as Assertion;
  }
  if (!Object.keys(patch).length) return fail(400, 'nothing_to_change');
  return patch;
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

/**
 * Asks (2026-11-03): a standing need or request, as one overlay entity of kind
 * `ask`. Every person is implicitly a gestalt box: an ask someone posts
 * anywhere is also theirs. Like the Gestalt Box model (caring, carrying,
 * placing, sharing and mentioning are separate facts), an ask keeps who cares,
 * who acts and where it was placed as separate facts, never one field:
 *
 * - `author`: who cares about it, always set. The owner (`{kind: 'self'}`) or
 *   one of the owner's person, company, project or idea entities, which is
 *   linked to the ask (relation `asks`, type `asks`). Fixed for the ask's life.
 * - `carrier`: who is responsible for acting, optional: the owner (`self`) or
 *   a person or company. Handing an ask over is setting its carrier.
 * - `placements`: where it was placed, beyond the author's own box (which is
 *   implicit): the owner's own stream (`self`, an ask addressed to them), a
 *   person's stream or a company, project or idea (`{id}`), or an app ref
 *   such as a conversation (`{ref}`).
 * - sharing is `exposure`: whom the owner means it for, `only_me` (the
 *   default), `this_chat` (with `exposureChat`), `friends`, `public`. Stored
 *   only: in v1 every read is the owner's own, and no ask is shown to anyone
 *   else whatever its exposure.
 *
 * Direction follows from those facts: `from_me` (the owner is the author),
 * `for_me` (placed on the owner's stream, or the owner carries it),
 * `from_others` (someone else cares), `about:<entity id>` (that entity is the
 * author, the carrier or a placement).
 *
 * - `horizon` is how fast it goes stale: `event` (tied to a date), `short`,
 *   `medium`, `evergreen`; it sets the default `recheckAfter`. Nothing closes
 *   an ask automatically: past `recheckAfter` an open ask reads
 *   `needsRecheck: true` until it is rechecked or its status changes.
 * - `status`: `open`, `fulfilled`, `withdrawn`, or `stale` (not known to be
 *   current, not closed).
 * - `evidence` is where it came from: a short quote, a URL, a label, when it
 *   was seen, and the overlay note it was recorded in, all optional.
 * - Who recorded it is `recordedBy` / `recordedVia` / `assertion` (the
 *   provenance notes and links carry as `author` / `source` / `assertion`;
 *   on an ask, `author` is who cares).
 *
 * The same author and the same text is one ask: a repeated save returns the
 * existing ask unchanged, so retries and re-imports never double it.
 */
/** Who can care about (author) an ask or be a placement: a person, company, project or idea; never a topic or another ask. */
export const ASKER_KINDS: readonly EntityKind[] = ['person', 'company', 'project', 'idea'];
/** Who can carry (act on) an ask: a person or a company. */
export const CARRIER_KINDS: readonly EntityKind[] = ['person', 'company'];
export const ASK_HORIZONS = ['event', 'short', 'medium', 'evergreen'] as const;
export type AskHorizon = (typeof ASK_HORIZONS)[number];
/** Default days until an ask is due for a recheck, by horizon. */
export const ASK_RECHECK_DAYS: Readonly<Record<AskHorizon, number>> = { event: 7, short: 14, medium: 60, evergreen: 90 };
export const ASK_STATUSES = ['open', 'fulfilled', 'withdrawn', 'stale'] as const;
export type AskStatus = (typeof ASK_STATUSES)[number];
export const ASK_EXPOSURES = ['only_me', 'this_chat', 'friends', 'public'] as const;
export type AskExposure = (typeof ASK_EXPOSURES)[number];
export const ASK_DIRECTIONS = ['from_me', 'for_me', 'from_others'] as const;
export type AskDirection = (typeof ASK_DIRECTIONS)[number];
export interface AskEvidence { quote: string | null; url: string | null; label: string | null; seenAt: string | null; noteId: string | null }
/** A party to an ask: the owner, or one of their entities. */
export type AskParty = { kind: 'self' } | LinkEnd;
/** A place an ask was put: the owner's stream, one of their entities, or an app ref (a conversation, a board). */
export type AskPlacement = { kind: 'self' } | LinkEnd | { kind: 'ref'; ref: string };
/** Who recorded the ask and how (the provenance of the record, not who cares). */
export interface AskRecord { recordedBy: string | null; recordedVia: ProvenanceSource | null; assertion: Assertion | null }
/** The ask's own fields, as an `ask` entity carries them (parties as stored ids; `Ask` resolves them). */
export interface AskFields extends AskRecord {
  text: string; fromMe: boolean; forMe: boolean; horizon: AskHorizon; recheckAfter: string; needsRecheck: boolean; status: AskStatus;
  exposure: AskExposure; exposureChat: string | null; evidence: AskEvidence | null;
  createdAt: string; updatedAt: string; updatedBy: string | null; closedAt: string | null; checkedAt: string | null; revision: number;
}
/**
 * An ask as read: its fields and its parties. `author` is null only if the
 * caring entity is unreadable (it never is for a live ask: forgetting the
 * author forgets its asks); a forgotten carrier or placement is dropped.
 */
export interface Ask extends AskFields { id: string; author: AskParty | null; carrier: AskParty | null; placements: AskPlacement[] }
/** Who cares about, or carries, an ask: the owner, or one of their entities. */
export type AskPartyRef = { self: true } | { id: string };
/** Where an ask is placed: the owner's stream, an entity, or an app ref. Stored as `self`, `entity:<id>` or the ref itself. */
export type AskPlacementRef = { self: true } | { id: string } | { ref: string };
export interface AskInput {
  text: string; author: AskPartyRef; carrier: AskPartyRef | null; placements: AskPlacementRef[]; horizon: AskHorizon; recheckAfter: string | null; status: AskStatus;
  exposure: AskExposure; exposureChat: string | null; evidence: AskEvidence | null;
}
export interface AskPatch {
  text?: string; carrier?: AskPartyRef | null; placements?: AskPlacementRef[]; horizon?: AskHorizon; recheckAfter?: string | null; status?: AskStatus; exposure?: AskExposure;
  exposureChat?: string | null; evidence?: AskEvidence | null; recheckedNow?: true;
}
export interface AskFilter { status: AskStatus[] | null; direction: AskDirection | null; about: string | null; q: string; needsRecheck: boolean; limit: number }

const oneOf = <T extends string>(values: readonly T[], value: unknown, code: string): T => values.includes(value as T) ? value as T : fail(400, code);
/** Ask text: up to 1,000 characters, control characters stripped, whitespace collapsed. */
export const cleanAskText = (value: unknown): string => cleanText(value, LIMITS.askLength, 'invalid_ask').replace(/\s+/g, ' ');
/** A date or date-time, stored as an ISO instant (a bare date is midnight UTC). */
export function cleanInstant(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}([T ][0-9:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(value.trim())) return fail(400, code);
  const at = Date.parse(value.trim().length === 10 ? `${value.trim()}T00:00:00.000Z` : value.trim());
  return Number.isFinite(at) ? new Date(at).toISOString() : fail(400, code);
}
export function cleanAskEvidence(value: unknown): AskEvidence | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return fail(400, 'invalid_evidence');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['quote', 'url', 'label', 'seenAt', 'noteId'].includes(key))) return fail(400, 'invalid_evidence');
  const quote = input.quote === undefined || input.quote === null || input.quote === '' ? null : cleanText(input.quote, LIMITS.quoteLength, 'invalid_evidence');
  let url: string | null = null;
  if (input.url !== undefined && input.url !== null && input.url !== '') {
    if (typeof input.url !== 'string' || input.url.length > LIMITS.urlLength || /\s/.test(input.url)) return fail(400, 'invalid_evidence');
    try { const parsed = new URL(input.url); if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return fail(400, 'invalid_evidence'); } catch { return fail(400, 'invalid_evidence'); }
    url = input.url;
  }
  const label = cleanLine(input.label, LIMITS.labelLength, 'invalid_evidence');
  const seenAt = cleanLine(input.seenAt, LIMITS.dateTextLength, 'invalid_evidence');
  const noteId = input.noteId === undefined || input.noteId === null || input.noteId === '' ? null : isId(input.noteId) ? input.noteId : fail(400, 'invalid_evidence');
  return quote || url || label || seenAt || noteId ? { quote, url, label, seenAt, noteId } : null;
}
function cleanExposure(exposure: unknown, chat: unknown): { exposure: AskExposure; exposureChat: string | null } {
  const value = exposure === undefined || exposure === null ? 'only_me' : oneOf(ASK_EXPOSURES, exposure, 'invalid_exposure');
  if (value !== 'this_chat') return chat === undefined || chat === null || chat === '' ? { exposure: value, exposureChat: null } : fail(400, 'invalid_exposure');
  return { exposure: value, exposureChat: cleanRef(chat) };
}
/** A party: `'self'` (or `{self: true}`) for the owner, or `{id}` of one of their entities. */
export function cleanAskParty(value: unknown, code: string): AskPartyRef {
  if (value === 'self' || (value && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>).self === true && Object.keys(value).length === 1)) return { self: true };
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && isId((value as Record<string, unknown>).id)) return { id: (value as { id: string }).id };
  return fail(400, code);
}
/** Placements: `'self'`, `{id}` or `{ref}`, at most 8, duplicates collapsed. */
export function cleanAskPlacements(value: unknown): AskPlacementRef[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > LIMITS.placementsPerAsk) return fail(400, 'invalid_placement');
  const seen = new Set<string>(), result: AskPlacementRef[] = [];
  for (const item of value) {
    const placement: AskPlacementRef = item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length === 1 && 'ref' in item
      ? { ref: cleanRef((item as { ref: unknown }).ref) } : cleanAskParty(item, 'invalid_placement');
    const key = placementKey(placement);
    if (!seen.has(key)) { seen.add(key); result.push(placement); }
  }
  return result;
}
/** How a placement is stored: `self`, `entity:<id>`, or the ref (refs always contain two colons; `self` and `entity:` never do). */
export const placementKey = (placement: AskPlacementRef): string => 'self' in placement ? 'self' : 'id' in placement ? `entity:${placement.id}` : placement.ref;
const ASK_INPUT_KEYS = ['text', 'author', 'carrier', 'placements', 'horizon', 'recheckAfter', 'status', 'exposure', 'exposureChat', 'evidence'];
/** A new ask. `author` (who cares) is required: `'self'` or `{id}`; `carrier` and `placements` are optional. */
export function parseAskInput(value: unknown): AskInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(400, 'invalid_ask');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !ASK_INPUT_KEYS.includes(key))) return fail(400, 'invalid_ask');
  return {
    text: cleanAskText(input.text), author: cleanAskParty(input.author, 'invalid_author'),
    carrier: input.carrier === undefined || input.carrier === null ? null : cleanAskParty(input.carrier, 'invalid_carrier'),
    placements: cleanAskPlacements(input.placements),
    horizon: input.horizon === undefined || input.horizon === null ? 'medium' : oneOf(ASK_HORIZONS, input.horizon, 'invalid_horizon'),
    recheckAfter: input.recheckAfter === undefined || input.recheckAfter === null ? null : cleanInstant(input.recheckAfter, 'invalid_recheck_after'),
    status: input.status === undefined || input.status === null ? 'open' : oneOf(ASK_STATUSES, input.status, 'invalid_status'),
    ...cleanExposure(input.exposure, input.exposureChat), evidence: cleanAskEvidence(input.evidence),
  };
}
/**
 * An edit to an ask. Absent leaves a field; `recheckAfter: null` returns to
 * the horizon's default; `evidence: null` clears it; `carrier: null` takes it
 * back; `placements` replaces the list. The author never changes.
 */
export function parseAskPatch(value: unknown): AskPatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(400, 'invalid_ask');
  const input = value as Record<string, unknown>, patch: AskPatch = {};
  if ('author' in input) return fail(400, 'author_fixed');
  if (Object.keys(input).some(key => !['text', 'carrier', 'placements', 'horizon', 'recheckAfter', 'status', 'exposure', 'exposureChat', 'evidence', 'recheckedNow'].includes(key))) return fail(400, 'invalid_ask');
  if (input.text !== undefined) patch.text = cleanAskText(input.text);
  if (input.carrier !== undefined) patch.carrier = input.carrier === null ? null : cleanAskParty(input.carrier, 'invalid_carrier');
  if (input.placements !== undefined) patch.placements = cleanAskPlacements(input.placements);
  if (input.horizon !== undefined) patch.horizon = oneOf(ASK_HORIZONS, input.horizon, 'invalid_horizon');
  if (input.recheckAfter !== undefined) patch.recheckAfter = input.recheckAfter === null ? null : cleanInstant(input.recheckAfter, 'invalid_recheck_after');
  if (input.status !== undefined) patch.status = oneOf(ASK_STATUSES, input.status, 'invalid_status');
  if (input.exposure !== undefined || input.exposureChat !== undefined) {
    if (input.exposure === undefined) return fail(400, 'invalid_exposure');
    Object.assign(patch, cleanExposure(input.exposure, input.exposureChat));
  }
  if (input.evidence !== undefined) patch.evidence = cleanAskEvidence(input.evidence);
  if (input.recheckedNow !== undefined) {
    if (input.recheckedNow !== true) return fail(400, 'invalid_ask');
    patch.recheckedNow = true;
  }
  if (!Object.keys(patch).length) return fail(400, 'nothing_to_change');
  return patch;
}
/**
 * A list filter: `status` one value or comma-separated (default open and
 * stale; `all` for every status); `direction` `from_me`, `for_me`,
 * `from_others` or `about:<entity id>` (that entity is the author, the
 * carrier or a placement).
 */
export function parseAskFilter(value: { status?: unknown; direction?: unknown; q?: unknown; needsRecheck?: unknown; limit?: unknown } = {}): AskFilter {
  let status: AskStatus[] | null = ['open', 'stale'];
  if (value.status === 'all') status = null;
  else if (typeof value.status === 'string' && value.status) status = [...new Set(value.status.split(',').map(part => oneOf(ASK_STATUSES, part.trim(), 'invalid_status')))];
  else if (value.status !== undefined && value.status !== null && value.status !== '') return fail(400, 'invalid_status');
  let direction: AskDirection | null = null, about: string | null = null;
  if (typeof value.direction === 'string' && value.direction.startsWith('about:')) about = isId(value.direction.slice(6)) ? value.direction.slice(6) : fail(400, 'invalid_direction');
  else if (value.direction !== undefined && value.direction !== null && value.direction !== '') direction = oneOf(ASK_DIRECTIONS, value.direction, 'invalid_direction');
  const q = typeof value.q === 'string' ? nameKey(value.q).slice(0, LIMITS.nameLength) : '';
  const needsRecheck = value.needsRecheck === true || value.needsRecheck === 'true';
  const raw = typeof value.limit === 'string' && /^\d{1,3}$/.test(value.limit) ? Number(value.limit) : value.limit;
  const limit = typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 ? Math.min(raw, 200) : 100;
  return { status, direction, about, q, needsRecheck, limit };
}
/** When an ask is next due for a recheck: the given instant, or the horizon's default days from `from`. */
export const askRecheckAfter = (horizon: AskHorizon, from: string, given: string | null = null): string =>
  given ?? new Date(Date.parse(from) + ASK_RECHECK_DAYS[horizon] * DAY_MS).toISOString();
/** An ask's display name: its text, cut to a name's length. */
export const askName = (text: string): string => text.length <= LIMITS.nameLength ? text : `${text.slice(0, LIMITS.nameLength - 1).trimEnd()}…`;
/** The identity of an ask for one owner: who cares and what, so the same ask saved twice is one. */
export const askKeyOf = (author: AskPartyRef, text: string): string =>
  createHash('sha256').update(`${'self' in author ? 'owner' : `entity:${author.id}`}\n${nameKey(text)}`).digest('hex');
