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
 * Kept in step with `src/overlay/contract.ts` in the Noos repository, which
 * owns this layout. Change it there first.
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
export interface Note { id: string; text: string; createdAt: string; updatedAt: string }
export interface Link { id: string; relation: string; direction: 'out' | 'in'; other: { id: string; kind: EntityKind; name: string; refs: string[] }; createdAt: string }
export interface EntityDetail extends Entity { notes: Note[]; links: Link[] }
export interface DueEntity { id: string; name: string; refs: string[]; important: boolean; nextDueAt: string; lastContactAt: string | null }
export interface CardPatch { important?: boolean; cadenceDays?: number | null; cadenceMode?: CadenceMode; contactedNow?: boolean }

/** A verified caller: which app is asking, and on behalf of which owner. */
export interface OverlayPrincipal { app: string; ownerKey: string }

export class OverlayError extends Error {
  constructor(public readonly status: number, public readonly code: string) { super(code); }
}
export const fail = (status: number, code: string): never => { throw new OverlayError(status, code); };

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

/** `<app>:<type>:<value>`, for example `openchat:user:abc123`. */
export function cleanRef(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{1,30}:[a-z][a-z0-9-]{0,30}:[A-Za-z0-9._@%+-]{1,200}$/.test(value)) return fail(400, 'invalid_ref');
  return value;
}

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
