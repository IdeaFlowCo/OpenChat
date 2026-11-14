/**
 * Structured person fields with per-value provenance and history
 * (docs/PEOPLE_OVERLAY.md, "Person fields"; design in FriendCRM
 * docs/entity-resolution-addendum-history.md and docs/people-ux-structured-fields.md).
 *
 * Two append-only records, both owner-scoped and never edited or deleted (except
 * by owner erasure):
 *   OverlayFieldAssertion: one observation of one value (address, phone, Wi-Fi…),
 *     who recorded it, where it came from, when the source said it, evidence.
 *   OverlayFieldDecision: one owner judgement about a value (former, wrong,
 *     hidden, pin, unpin, restore, review), an assertion (retract) or a note
 *     suggestion (dismiss), or the undo of an earlier operation (revert).
 * The fields a person shows are computed at read time from the person's
 * assertions, decisions and address-book source cards (which are read as
 * assertions too, without being copied). Nothing is overwritten: an owner edit
 * is a new assertion plus a "former" decision on the value it replaces.
 */
import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { ManagedTransaction } from 'neo4j-driver';
import { cleanRequestId, fail, isId } from './contract.js';
import type { Note, Provenance } from './contract.js';
import type { ContactSource } from './contacts.js';

type Runner = Pick<ManagedTransaction, 'run'>;

export const FIELD_KINDS = ['address', 'phone', 'email', 'wifi', 'birthday', 'social', 'context', 'custom'] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];
/** Kinds a person normally has one current value of: two current values without an owner choice show as a conflict. */
export const SINGLE_KINDS: readonly FieldKind[] = ['address', 'birthday'];
export const FIELD_ACTIONS = ['former', 'wrong', 'hidden', 'pin', 'unpin', 'restore', 'review', 'retract', 'dismiss', 'revert'] as const;
export type FieldAction = (typeof FIELD_ACTIONS)[number];
/** Actions a caller may ask for by value (`retract`, `dismiss` and `revert` come from their own operations). */
const MARK_ACTIONS = ['former', 'wrong', 'hidden', 'pin', 'unpin', 'restore'] as const;
export type FieldStatus = 'current' | 'former' | 'wrong' | 'hidden' | 'review';

export const FIELD_CONSTRAINTS = [
  'CREATE CONSTRAINT overlay_field_assertion_id IF NOT EXISTS FOR (a:OverlayFieldAssertion) REQUIRE a.id IS UNIQUE',
  'CREATE CONSTRAINT overlay_field_decision_id IF NOT EXISTS FOR (d:OverlayFieldDecision) REQUIRE d.id IS UNIQUE',
  'CREATE CONSTRAINT overlay_field_operation IF NOT EXISTS FOR (o:OverlayFieldOperation) REQUIRE (o.ownerKey, o.requestId) IS UNIQUE',
  'CREATE INDEX overlay_field_assertion_entity IF NOT EXISTS FOR (a:OverlayFieldAssertion) ON (a.ownerKey, a.entityId)',
  'CREATE INDEX overlay_field_decision_entity IF NOT EXISTS FOR (d:OverlayFieldDecision) ON (d.ownerKey, d.entityId)',
];
export const FIELD_LABELS = ['OverlayFieldAssertion', 'OverlayFieldDecision', 'OverlayFieldOperation'] as const;

/** A structured value. `text` is the display form for every kind; Wi-Fi also has `ssid` and `password`. */
export interface FieldValue { text: string; ssid?: string; password?: string | null; secret?: boolean; type?: string }
export interface FieldEvidence { noteId?: string; quote?: string; messageDate?: string; sourceId?: string }
export interface FieldAssertion {
  id: string; kind: FieldKind; label: string | null; value: FieldValue; normalized: string;
  /** Where the fact came from: `owner`, `agent:<name>`, `note`, `imessage`, or an import source such as `google-contacts:<account>`. */
  source: string; sourceId: string | null; memberId: string;
  evidence: FieldEvidence | null; observedAt: string | null; recordedAt: string; recordedBy: string | null;
  origin: 'stated' | 'inferred' | 'imported'; operationId: string | null;
  status: FieldStatus; supersededBy: string | null; retracted: boolean;
}
export interface FieldDecision {
  id: string; kind: string | null; normalized: string | null; assertionId: string | null; noteId: string | null;
  action: FieldAction; reason: string | null; supersededBy: string | null; reverts: string | null;
  at: string; by: string | null; operationId: string | null;
}
/** One value of one kind, as shown: its current status and every assertion of it (newest first). */
export interface PersonField {
  key: string; kind: FieldKind; label: string | null; value: FieldValue; normalized: string; status: FieldStatus;
  pinned: boolean; primary: boolean; conflict: boolean; review: string | null; observedAt: string | null;
  assertions: Array<Omit<FieldAssertion, 'status' | 'retracted' | 'value' | 'normalized' | 'kind' | 'label'>>;
}
export interface FieldSuggestion {
  id: string; noteId: string; kind: FieldKind; label: string | null; value: FieldValue; normalized: string; quote: string;
  observedAt: string | null; corroborates: boolean;
}

// ---------------------------------------------------------------- normalisation

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const STREET_WORDS: Record<string, string> = { avenue: 'ave', street: 'st', road: 'rd', boulevard: 'blvd', drive: 'dr', lane: 'ln', court: 'ct', place: 'pl', terrace: 'ter', parkway: 'pkwy', circle: 'cir', highway: 'hwy', north: 'n', south: 's', east: 'e', west: 'w', apartment: 'apt', suite: 'ste' };
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const secretDigest = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

export function normalizeField(kind: FieldKind, value: FieldValue, label: string | null = null): string {
  const text = squash(value.text).toLowerCase();
  switch (kind) {
    case 'email': return text;
    case 'phone': {
      const digits = text.replace(/[^\d+]/g, '');
      const bare = digits.replace(/\D/g, '');
      if (digits.startsWith('+')) return `+${bare}`;
      if (bare.length === 10) return `+1${bare}`;
      if (bare.length === 11 && bare.startsWith('1')) return `+${bare}`;
      return bare;
    }
    case 'address': return text.replace(/[.,#]/g, ' ').split(/\s+/).filter(Boolean).map(w => STREET_WORDS[w] ?? w).join(' ');
    case 'social': return text.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '').replace(/\?.*$/, '');
    case 'wifi': return `${squash(value.ssid ?? value.text).toLowerCase()}|${value.password ? secretDigest(value.password) : ''}`;
    case 'birthday': {
      const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
      const md = text.match(/^([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?$/);
      if (md && MONTHS.includes(md[1])) return `${md[3] ?? '-'}-${String(MONTHS.indexOf(md[1]) + 1).padStart(2, '0')}-${md[2].padStart(2, '0')}`;
      return text;
    }
    case 'context': return `${(value.type ?? '').toLowerCase()}|${text}`;
    case 'custom': return `${(label ?? '').toLowerCase()}|${text}`;
  }
}

/** Validates a caller's value for a kind. Wi-Fi takes {ssid, password}; others a text (or {text}). */
export function cleanFieldValue(kind: FieldKind, raw: unknown): FieldValue {
  const line = (v: unknown, max: number) => typeof v === 'string' && squash(v).length > 0 && v.length <= max && !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(v) ? squash(v) : fail(400, 'invalid_field_value');
  if (kind === 'wifi') {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(400, 'invalid_field_value');
    const input = raw as Record<string, unknown>;
    if (Object.keys(input).some(k => !['ssid', 'password', 'text'].includes(k))) return fail(400, 'invalid_field_value');
    const ssid = line(input.ssid ?? input.text, 200);
    const password = input.password === undefined || input.password === null || input.password === '' ? null
      : typeof input.password === 'string' && input.password.length <= 200 && !/[\u0000-\u001f\u007f]/.test(input.password) ? input.password : fail(400, 'invalid_field_value');
    return { text: ssid, ssid, password };
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const input = raw as Record<string, unknown>;
    if (Object.keys(input).some(k => !['text', 'type'].includes(k))) return fail(400, 'invalid_field_value');
    return { text: line(input.text, 1000), ...(kind === 'context' && input.type !== undefined ? { type: line(input.type, 40).toLowerCase() } : {}) };
  }
  const text = line(raw, kind === 'address' || kind === 'custom' || kind === 'context' ? 1000 : 300);
  if (kind === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return fail(400, 'invalid_field_value');
  if (kind === 'phone' && (text.replace(/\D/g, '').length < 5 || /[a-z]/i.test(text.replace(/\b(ext|x)\b/gi, '')))) return fail(400, 'invalid_field_value');
  return { text };
}

/** Wi-Fi passwords are shown only through an explicit field read (`revealPersonField`). */
export function maskValue(value: FieldValue): FieldValue {
  return value.password ? { ...value, password: null, secret: true } : value;
}

const cleanKind = (raw: unknown): FieldKind => FIELD_KINDS.includes(raw as FieldKind) ? raw as FieldKind : fail(400, 'invalid_field_kind');
const cleanLabel = (raw: unknown): string | null => raw === undefined || raw === null || raw === '' ? null
  : typeof raw === 'string' && raw.length <= 60 && !/[\u0000-\u001f\u007f]/.test(raw) ? squash(raw) : fail(400, 'invalid_field_label');
const cleanSourceName = (raw: unknown): string => typeof raw === 'string' && /^[a-z][a-z0-9-]{0,40}(:[\x21-\x7e]{1,200})?$/.test(raw) ? raw : fail(400, 'invalid_field_source');
const cleanDate = (raw: unknown): string | null => {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string' || !/^\d{4}(-\d{2}(-\d{2}(T[\d:.]+Z)?)?)?$/.test(raw) || !Number.isFinite(Date.parse(raw.length === 4 ? `${raw}-01-01` : raw.length === 7 ? `${raw}-01` : raw))) return fail(400, 'invalid_observed_at');
  return raw;
};
function cleanEvidence(raw: unknown): FieldEvidence | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return fail(400, 'invalid_field_evidence');
  const input = raw as Record<string, unknown>, out: FieldEvidence = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'noteId') { if (!isId(value)) return fail(400, 'invalid_field_evidence'); out.noteId = value; }
    else if (key === 'quote' || key === 'sourceId') { if (typeof value !== 'string' || !value || value.length > 1000) return fail(400, 'invalid_field_evidence'); out[key] = value; }
    else if (key === 'messageDate') out.messageDate = cleanDate(value) ?? undefined;
    else return fail(400, 'invalid_field_evidence');
  }
  return Object.keys(out).length ? out : null;
}

export interface SetFieldInput {
  kind: FieldKind; label: string | null; value: FieldValue; source: string; sourceId: string | null; evidence: FieldEvidence | null;
  observedAt: string | null; origin: 'stated' | 'inferred'; requestId: string; status: 'current' | 'former' | 'review' | null;
  review: string | null; supersedes: string | null; suggestionId: string | null;
}
export function parseSetFieldInput(raw: unknown, author: string): SetFieldInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(400, 'invalid_field');
  const input = raw as Record<string, unknown>;
  const allowed = ['kind', 'label', 'value', 'source', 'sourceId', 'evidence', 'observedAt', 'assertion', 'clientRequestId', 'status', 'review', 'supersedes', 'suggestionId'];
  if (Object.keys(input).some(k => !allowed.includes(k))) return fail(400, 'invalid_field');
  const suggestionId = input.suggestionId === undefined ? null : typeof input.suggestionId === 'string' && /^sug_[a-f0-9]{24}$/.test(input.suggestionId) ? input.suggestionId : fail(400, 'invalid_field');
  const kind = suggestionId && input.kind === undefined ? 'custom' : cleanKind(input.kind);
  const label = cleanLabel(input.label);
  const value = suggestionId && input.value === undefined ? { text: '-' } : cleanFieldValue(kind, input.value);
  const status = input.status === undefined || input.status === null ? null : ['current', 'former', 'review'].includes(input.status as string) ? input.status as 'current' | 'former' | 'review' : fail(400, 'invalid_field');
  const review = input.review === undefined || input.review === null ? null : typeof input.review === 'string' && input.review.length <= 280 ? squash(input.review) : fail(400, 'invalid_field');
  return {
    kind, label, value, source: input.source === undefined ? author : cleanSourceName(input.source),
    sourceId: input.sourceId === undefined || input.sourceId === null ? null : typeof input.sourceId === 'string' && input.sourceId.length <= 512 ? input.sourceId : fail(400, 'invalid_field'),
    evidence: cleanEvidence(input.evidence), observedAt: cleanDate(input.observedAt),
    origin: input.assertion === undefined || input.assertion === 'stated' ? 'stated' : input.assertion === 'inferred' ? 'inferred' : fail(400, 'invalid_field'),
    requestId: cleanRequestId(input.clientRequestId), status: review && !status ? 'review' : status, review,
    supersedes: input.supersedes === undefined || input.supersedes === null ? null : typeof input.supersedes === 'string' && /^[a-z0-9_:-]{1,120}$/i.test(input.supersedes) ? input.supersedes : fail(400, 'invalid_field'),
    suggestionId,
  };
}
export interface MarkFieldInput { action: FieldAction; key: string | null; assertionId: string | null; operationId: string | null; suggestionId: string | null; reason: string | null; requestId: string }
export function parseMarkFieldInput(raw: unknown): MarkFieldInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(400, 'invalid_field_mark');
  const input = raw as Record<string, unknown>;
  if (Object.keys(input).some(k => !['action', 'key', 'assertionId', 'operationId', 'suggestionId', 'reason', 'clientRequestId'].includes(k))) return fail(400, 'invalid_field_mark');
  const action = input.action === 'undo' ? 'revert' : input.action === 'dismiss' || input.action === 'retract' || MARK_ACTIONS.includes(input.action as typeof MARK_ACTIONS[number]) ? input.action as FieldAction : fail(400, 'invalid_field_mark');
  const ref = (v: unknown) => v === undefined || v === null ? null : typeof v === 'string' && /^[A-Za-z0-9_:|.@+-]{1,300}$/.test(v) ? v : fail(400, 'invalid_field_mark');
  const out: MarkFieldInput = { action, key: ref(input.key), assertionId: ref(input.assertionId), operationId: ref(input.operationId), suggestionId: ref(input.suggestionId),
    reason: input.reason === undefined || input.reason === null ? null : typeof input.reason === 'string' && input.reason.length <= 280 ? squash(input.reason) : fail(400, 'invalid_field_mark'),
    requestId: cleanRequestId(input.clientRequestId) };
  if (action === 'revert' && !out.operationId) return fail(400, 'invalid_field_mark');
  if (action === 'dismiss' && !out.suggestionId) return fail(400, 'invalid_field_mark');
  if (action === 'retract' && !out.assertionId) return fail(400, 'invalid_field_mark');
  if (MARK_ACTIONS.includes(action as typeof MARK_ACTIONS[number]) && !out.key) return fail(400, 'invalid_field_mark');
  return out;
}

// ---------------------------------------------------------------- reading

const valueKey = (kind: string, normalized: string) => `${kind}:${createHash('sha256').update(normalized).digest('hex').slice(0, 20)}`;
const SOURCE_KINDS: Record<string, FieldKind> = { email: 'email', phone: 'phone', social: 'social', website: 'social', url: 'social', address: 'address', birthday: 'birthday' };
/** Apple's internal labels (`_$!<Home>!$_`) read as their words. */
const sourceLabel = (raw: unknown) => typeof raw === 'string' && raw ? raw.replace(/^_\$!<(.+)>!\$_$/, '$1') || null : null;

/** Address-book cards read as assertions (never copied): same value from the same card is one assertion. */
export function sourceAssertions(sources: Array<ContactSource & { memberId?: string }>, headId: string): FieldAssertion[] {
  const out: FieldAssertion[] = [];
  for (const card of sources) {
    const details = Array.isArray((card.data as { details?: unknown }).details) ? (card.data as { details: unknown[] }).details : [];
    const seen = new Set<string>();
    for (const raw of details) {
      const detail = raw as { kind?: unknown; value?: unknown; label?: unknown };
      const kind = SOURCE_KINDS[String(detail?.kind)];
      if (!kind || typeof detail.value !== 'string' || !detail.value.trim()) continue;
      const value = { text: squash(detail.value) }, normalized = normalizeField(kind, value);
      if (seen.has(`${kind}|${normalized}`)) continue;
      seen.add(`${kind}|${normalized}`);
      out.push({
        id: `src_${createHash('sha256').update(JSON.stringify([card.source, card.sourceId, kind, normalized])).digest('hex').slice(0, 24)}`,
        kind, label: kind === 'social' ? sourceLabel(detail.label) ?? socialName(normalized) : sourceLabel(detail.label), value, normalized,
        source: card.source, sourceId: card.sourceId, memberId: card.memberId ?? headId, evidence: null,
        // An import time is when it was recorded, never when the person said it.
        observedAt: null, recordedAt: card.updatedAt, recordedBy: card.provenance?.author ?? null, origin: 'imported', operationId: null,
        status: 'current', supersededBy: null, retracted: false,
      });
    }
  }
  return out;
}
const socialName = (normalized: string) => /linkedin\.com/.test(normalized) ? 'LinkedIn' : /facebook\.com|fb\.com/.test(normalized) ? 'Facebook' : /twitter\.com|x\.com/.test(normalized) ? 'X' : /instagram\.com/.test(normalized) ? 'Instagram' : null;

export async function storedAssertionsIn(tx: Runner, ownerKey: string, ids: string[]): Promise<{ assertions: FieldAssertion[]; decisions: FieldDecision[] }> {
  const a = await tx.run('MATCH (a:OverlayFieldAssertion {ownerKey:$ownerKey}) WHERE a.entityId IN $ids RETURN a { .* } AS a ORDER BY a.recordedAt, a.id', { ownerKey, ids });
  const d = await tx.run('MATCH (d:OverlayFieldDecision {ownerKey:$ownerKey}) WHERE d.entityId IN $ids RETURN d { .* } AS d ORDER BY d.at, d.seq, d.id', { ownerKey, ids });
  return {
    assertions: a.records.map(r => {
      const x = r.get('a') as Record<string, any>;
      return { id: x.id, kind: x.kind, label: x.label ?? null, value: JSON.parse(x.value), normalized: x.normalized, source: x.source, sourceId: x.sourceId ?? null,
        memberId: x.entityId, evidence: x.evidence ? JSON.parse(x.evidence) : null, observedAt: x.observedAt ?? null, recordedAt: x.recordedAt,
        recordedBy: x.recordedBy ?? null, origin: x.origin, operationId: x.operationId ?? null, status: 'current', supersededBy: null, retracted: false };
    }),
    decisions: d.records.map(r => {
      const x = r.get('d') as Record<string, any>;
      return { id: x.id, kind: x.kind ?? null, normalized: x.normalized ?? null, assertionId: x.assertionId ?? null, noteId: x.noteId ?? null, action: x.action,
        reason: x.reason ?? null, supersededBy: x.supersededBy ?? null, reverts: x.reverts ?? null, at: x.at, by: x.by ?? null, operationId: x.operationId ?? null };
    }),
  };
}

const when = (a: { observedAt: string | null; recordedAt: string }) => a.observedAt ?? a.recordedAt;
/** Owner statements outrank agents, which outrank imports and evidence (design addendum §3). */
const rank = (a: FieldAssertion) => a.source === 'owner' ? 3 : a.origin === 'stated' && a.source.startsWith('agent:') ? 2 : 1;

/**
 * The person's fields: one entry per (kind, normalized value), each with its
 * status and every assertion of it. For single-valued kinds the first current
 * value is `primary`; another current or unreviewed value with no owner pin
 * makes both `conflict`.
 */
export function projectFields(assertions: FieldAssertion[], decisions: FieldDecision[], reveal = false): PersonField[] {
  const reverted = new Set(decisions.filter(d => d.action === 'revert' && d.reverts).map(d => d.reverts!));
  const live = decisions.filter(d => d.action !== 'revert' && !reverted.has(d.id));
  const retracted = new Set(live.filter(d => d.action === 'retract' && d.assertionId).map(d => d.assertionId!));
  const groups = new Map<string, FieldAssertion[]>();
  for (const a of assertions) {
    if (retracted.has(a.id)) continue;
    const key = valueKey(a.kind, a.normalized);
    groups.set(key, [...(groups.get(key) ?? []), a]);
  }
  const fields: PersonField[] = [];
  for (const [key, list] of groups) {
    const mine = live.filter(d => d.kind === list[0].kind && d.normalized === list[0].normalized);
    let status: FieldStatus = 'current', pinned = false, review: string | null = null, supersededBy: string | null = null, statusAt = '';
    for (const d of mine) {
      if (d.action === 'pin') pinned = true;
      else if (d.action === 'unpin') pinned = false;
      else if (d.action === 'restore') { status = 'current'; review = null; supersededBy = null; statusAt = d.at; }
      else if (d.action === 'former' || d.action === 'wrong' || d.action === 'hidden') { status = d.action; supersededBy = d.supersededBy; statusAt = d.at; }
      else if (d.action === 'review') { status = 'review'; review = d.reason; statusAt = d.at; }
    }
    // A former value said again later (an owner or agent statement after the decision) is current again; imports never revive it.
    if (status === 'former' && list.some(a => a.origin === 'stated' && a.recordedAt > statusAt)) { status = 'current'; supersededBy = null; }
    const sorted = list.slice().sort((a, b) => rank(b) - rank(a) || when(b).localeCompare(when(a)));
    const lead = sorted[0];
    fields.push({
      key, kind: lead.kind, label: sorted.find(a => a.label)?.label ?? null, value: reveal ? lead.value : maskValue(lead.value), normalized: lead.normalized,
      status, pinned, primary: false, conflict: false, review, observedAt: list.map(when).sort().at(-1) ?? null,
      assertions: sorted.map(({ status: _s, retracted: _r, value: _v, normalized: _n, kind: _k, label: _l, ...rest }) => ({ ...rest, supersededBy: rest.supersededBy ?? supersededBy })),
    });
  }
  const order = (f: PersonField) => (f.pinned ? 0 : 2) + (f.status === 'current' ? 0 : f.status === 'review' ? 1 : 4);
  const strongest = (f: PersonField) => Math.max(...f.assertions.map(a => a.source === 'owner' ? 3 : a.origin === 'stated' && a.source.startsWith('agent:') ? 2 : 1));
  fields.sort((a, b) => FIELD_KINDS.indexOf(a.kind) - FIELD_KINDS.indexOf(b.kind) || order(a) - order(b) || strongest(b) - strongest(a) || (b.observedAt ?? '').localeCompare(a.observedAt ?? ''));
  for (const kind of SINGLE_KINDS) {
    const live = fields.filter(f => f.kind === kind && (f.status === 'current' || f.status === 'review'));
    const shown = live.filter(f => f.status === 'current');
    if (!shown.length) continue;
    shown[0].primary = true;
    // Pinned values are each the owner's choice; otherwise a second current or unreviewed value is a conflict.
    if (shown[0].pinned) { for (const f of shown.filter(f => f.pinned)) f.primary = true; continue; }
    if (live.length > 1) for (const f of live) f.conflict = true;
  }
  for (const f of fields) if (!SINGLE_KINDS.includes(f.kind) && f.status === 'current') f.primary = true;
  return fields;
}

// ---------------------------------------------------------------- suggestions from notes

const ADDRESS = /\b\d{1,6}[A-Za-z]?\s+(?:[NSEW]\.?\s+)?(?:[A-Z0-9][\w'.-]*\s+){0,4}(?:Avenue|Ave|Street|St|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Court|Ct|Place|Pl|Terrace|Ter|Parkway|Pkwy|Circle|Cir|Highway|Hwy)\b\.?(?:,?\s+(?:Apt|Unit|Suite|Ste|#)\.?\s*[\w-]+)?(?:,\s*[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,2})?(?:,?\s+[A-Z]{2}\b)?(?:\s+\d{5}(?:-\d{4})?)?/g;
const WIFI = /\bwi-?fi\b[^:\n]{0,40}?[:\-–]?\s*(?:network|ssid|name)?\s*[:=]?\s*["“]?([^\s,;"”/]{1,64})["”]?\s*(?:,|\/|;|\band\b)?\s*(?:password|pass(?:word|code)?|pw|pwd|key)\s*[:=]?\s*["“]?([^\s"”]{1,64})/i;
const BIRTHDAY = /\b(?:birthday|bday|born)\b(?:\s+(?:is|on))?\s*[:,-]?\s*((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:,?\s+\d{4})?|\d{4}-\d{2}-\d{2})/i;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PHONE = /(?:\+\d{1,3}[\s.-]?)?\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g;

/** Candidate fields in one note's text, deterministically (no model). The note is never changed. */
export function extractFields(text: string): Array<{ kind: FieldKind; label: string | null; value: FieldValue; quote: string }> {
  const out: Array<{ kind: FieldKind; label: string | null; value: FieldValue; quote: string }> = [];
  // Machine records (`[contact v1] …`, `[friend-ask v1]`) are evidence already imported elsewhere.
  if (/^\s*\[[a-z-]+ v\d+\]/i.test(text)) return out;
  for (const m of text.matchAll(ADDRESS)) {
    const value = m[0].replace(/[\s,.]+$/, '');
    if (!/[A-Za-z]{3,}/.test(value)) continue;
    const before = text.slice(Math.max(0, m.index! - 40), m.index!);
    const label = /guest/i.test(before) ? 'guest' : /work|office/i.test(before) ? 'work' : /home/i.test(before) ? 'home' : null;
    out.push({ kind: 'address', label, value: { text: value }, quote: sentenceAround(text, m.index!, m[0].length) });
  }
  const wifi = text.match(WIFI);
  if (wifi) {
    const ssid = wifi[1], password = wifi[2].replace(/[),.;]+$/, '');
    const before = text.slice(Math.max(0, wifi.index! - 20), wifi.index! + 12);
    out.push({ kind: 'wifi', label: /guest/i.test(before) ? 'guest' : null, value: { text: ssid, ssid, password }, quote: `Wi-Fi ${ssid}` });
  }
  const birthday = text.match(BIRTHDAY);
  if (birthday) out.push({ kind: 'birthday', label: null, value: { text: birthday[1] }, quote: sentenceAround(text, birthday.index!, birthday[0].length) });
  for (const m of text.matchAll(EMAIL)) out.push({ kind: 'email', label: null, value: { text: m[0] }, quote: m[0] });
  for (const m of text.matchAll(PHONE)) out.push({ kind: 'phone', label: null, value: { text: m[0].trim() }, quote: sentenceAround(text, m.index!, m[0].length) });
  return out;
}
function sentenceAround(text: string, index: number, length: number): string {
  const start = Math.max(text.lastIndexOf('\n', index), text.lastIndexOf('. ', index) + 1, 0);
  const endDot = text.indexOf('. ', index + length), endLine = text.indexOf('\n', index + length);
  const end = [endDot, endLine, text.length].filter(x => x >= 0).reduce((a, b) => Math.min(a, b));
  return squash(text.slice(start, end + (end === endDot ? 1 : 0))).slice(0, 280);
}
export const suggestionId = (noteId: string, kind: string, normalized: string) => `sug_${createHash('sha256').update(JSON.stringify([noteId, kind, normalized])).digest('hex').slice(0, 24)}`;

/**
 * Suggestions for a person's notes: each extracted value not dismissed for that
 * note and not already recorded from that note. A value the person already has
 * from elsewhere is offered as corroboration ("Add as source").
 */
export function fieldSuggestions(notes: Note[], fields: PersonField[], decisions: FieldDecision[], reveal = false): FieldSuggestion[] {
  const reverted = new Set(decisions.filter(d => d.action === 'revert' && d.reverts).map(d => d.reverts!));
  const dismissed = new Set(decisions.filter(d => d.action === 'dismiss' && !reverted.has(d.id)).map(d => d.reason));
  const out: FieldSuggestion[] = [];
  for (const note of notes) {
    for (const found of extractFields(note.text)) {
      const normalized = normalizeField(found.kind, found.value, found.label);
      const id = suggestionId(note.id, found.kind, normalized);
      if (dismissed.has(id)) continue;
      const existing = fields.find(f => f.kind === found.kind && f.normalized === normalized);
      if (existing?.assertions.some(a => a.evidence?.noteId === note.id)) continue;
      // Imported address-book values need no note to back them; only owner/agent-recorded values do.
      if (existing && (found.kind === 'email' || found.kind === 'phone') && existing.assertions.some(a => a.origin === 'imported')) continue;
      out.push({ id, noteId: note.id, kind: found.kind, label: found.label, value: reveal ? found.value : maskValue(found.value), normalized, quote: found.kind === 'wifi' ? found.quote : found.quote,
        observedAt: note.createdAt ?? null, corroborates: !!existing && existing.status !== 'wrong' });
    }
  }
  return out;
}

// ---------------------------------------------------------------- writing

async function operationIn(tx: Runner, ownerKey: string, requestId: string, entityId: string, kind: string): Promise<{ id: string; replayed: boolean }> {
  const found = await tx.run('MATCH (o:OverlayFieldOperation {ownerKey:$ownerKey, requestId:$requestId}) RETURN o.id AS id, o.entityId AS entityId, o.kind AS kind', { ownerKey, requestId });
  const row = found.records[0];
  if (row) {
    if (row.get('entityId') !== entityId || row.get('kind') !== kind) return fail(409, 'operation_id_reused');
    return { id: String(row.get('id')), replayed: true };
  }
  const id = `fop_${nanoid()}`;
  await tx.run('CREATE (:OverlayFieldOperation {id:$id, ownerKey:$ownerKey, requestId:$requestId, entityId:$entityId, kind:$kind, at:$at})', { id, ownerKey, requestId, entityId, kind, at: new Date().toISOString() });
  return { id, replayed: false };
}
let sequence = 0;
async function decide(tx: Runner, ownerKey: string, entityId: string, d: Omit<FieldDecision, 'id' | 'at'>, by: Provenance): Promise<string> {
  const id = `fdc_${nanoid()}`;
  await tx.run(`CREATE (:OverlayFieldDecision {id:$id, ownerKey:$ownerKey, entityId:$entityId, kind:$kind, normalized:$normalized, assertionId:$assertionId, noteId:$noteId,
    action:$action, reason:$reason, supersededBy:$supersededBy, reverts:$reverts, at:$at, seq:$seq, by:$by, operationId:$operationId})`,
    { id, ownerKey, entityId, ...d, at: new Date().toISOString(), seq: ++sequence, by: by.author });
  return id;
}

export interface FieldContext { headId: string; ids: string[]; notes: Note[]; sources: Array<ContactSource & { memberId?: string }> }
export type FieldsResult = { operationId: string; replayed: boolean; assertionId?: string; key?: string };

/** Records one value; with `supersedes` (a value key) the old value becomes former, superseded by this one. */
export async function setFieldIn(tx: Runner, ownerKey: string, ctx: FieldContext, input: SetFieldInput, by: Provenance & { actorId?: string }): Promise<FieldsResult> {
  const op = await operationIn(tx, ownerKey, input.requestId, ctx.headId, 'set');
  if (op.replayed) {
    const found = await tx.run('MATCH (a:OverlayFieldAssertion {ownerKey:$ownerKey, operationId:$op}) RETURN a.id AS id, a.kind AS kind, a.normalized AS normalized LIMIT 1', { ownerKey, op: op.id });
    const row = found.records[0];
    return { operationId: op.id, replayed: true, ...(row ? { assertionId: String(row.get('id')), key: valueKey(String(row.get('kind')), String(row.get('normalized'))) } : {}) };
  }
  let { kind, label, value, evidence, observedAt, source } = input;
  if (input.suggestionId) {
    // Accepting a note suggestion re-reads the note here, so a secret never has to travel through the caller.
    const stored = await storedAssertionsIn(tx, ownerKey, ctx.ids);
    const fields = projectFields([...stored.assertions, ...sourceAssertions(ctx.sources, ctx.headId)], stored.decisions);
    const suggestion = fieldSuggestions(ctx.notes, fields, stored.decisions, true).find(s => s.id === input.suggestionId);
    if (!suggestion) return fail(404, 'suggestion_not_found');
    kind = suggestion.kind; label = input.label ?? suggestion.label;
    value = input.value.text !== '-' && input.kind === suggestion.kind ? input.value : suggestion.value;
    evidence = { noteId: suggestion.noteId, quote: kind === 'wifi' ? `Wi-Fi ${value.ssid ?? ''}`.trim() : suggestion.quote };
    observedAt = observedAt ?? suggestion.observedAt; source = 'note';
  }
  if (evidence?.noteId) {
    const note = await tx.run('MATCH (n:OverlayNote {ownerKey:$ownerKey, id:$id}) WHERE n.entityId IN $ids RETURN n.id AS id', { ownerKey, id: evidence.noteId, ids: ctx.ids });
    if (!note.records.length) return fail(400, 'invalid_field_evidence');
  }
  const normalized = normalizeField(kind, value, label);
  const id = `fas_${nanoid()}`;
  await tx.run(`CREATE (:OverlayFieldAssertion {id:$id, ownerKey:$ownerKey, entityId:$entityId, kind:$kind, label:$label, value:$value, normalized:$normalized,
    source:$source, sourceId:$sourceId, evidence:$evidence, observedAt:$observedAt, recordedAt:$recordedAt, recordedBy:$recordedBy, actorId:$actorId, origin:$origin, operationId:$operationId})`, {
    id, ownerKey, entityId: ctx.headId, kind, label, value: JSON.stringify(value), normalized, source, sourceId: input.sourceId,
    evidence: evidence ? JSON.stringify(evidence) : null, observedAt, recordedAt: new Date().toISOString(), recordedBy: by.author, actorId: by.actorId ?? null,
    origin: input.origin, operationId: op.id });
  const key = valueKey(kind, normalized);
  if (input.status === 'former' || input.status === 'review') await decide(tx, ownerKey, ctx.headId, { kind, normalized, assertionId: id, noteId: null, action: input.status, reason: input.review, supersededBy: null, reverts: null, by: by.author, operationId: op.id }, by);
  if (input.supersedes && input.supersedes !== key) {
    const stored = await storedAssertionsIn(tx, ownerKey, ctx.ids);
    const old = projectFields([...stored.assertions, ...sourceAssertions(ctx.sources, ctx.headId)], stored.decisions).find(f => f.key === input.supersedes);
    if (!old) return fail(404, 'field_not_found');
    await decide(tx, ownerKey, ctx.headId, { kind: old.kind, normalized: old.normalized, assertionId: null, noteId: null, action: 'former', reason: input.source === 'owner' || by.author === 'owner' ? 'owner_edit' : 'corrected', supersededBy: id, reverts: null, by: by.author, operationId: op.id }, by);
  }
  return { operationId: op.id, replayed: false, assertionId: id, key };
}

/** Judges one value (by key), retracts one assertion, dismisses one suggestion, or undoes an earlier operation. */
export async function markFieldIn(tx: Runner, ownerKey: string, ctx: FieldContext, input: MarkFieldInput, by: Provenance): Promise<FieldsResult> {
  const op = await operationIn(tx, ownerKey, input.requestId, ctx.headId, `mark:${input.action}`);
  if (op.replayed) return { operationId: op.id, replayed: true };
  const stored = await storedAssertionsIn(tx, ownerKey, ctx.ids);
  const all = [...stored.assertions, ...sourceAssertions(ctx.sources, ctx.headId)];
  if (input.action === 'revert') {
    const target = await tx.run('MATCH (o:OverlayFieldOperation {ownerKey:$ownerKey, id:$id}) WHERE o.entityId IN $ids RETURN o.id AS id', { ownerKey, id: input.operationId, ids: ctx.ids });
    if (!target.records.length) return fail(404, 'operation_not_found');
    const reverted = new Set(stored.decisions.filter(d => d.action === 'revert').map(d => d.reverts));
    for (const d of stored.decisions.filter(d => d.operationId === input.operationId && !reverted.has(d.id)))
      await decide(tx, ownerKey, ctx.headId, { kind: d.kind, normalized: d.normalized, assertionId: null, noteId: null, action: 'revert', reason: input.reason, supersededBy: null, reverts: d.id, by: by.author, operationId: op.id }, by);
    for (const a of stored.assertions.filter(a => a.operationId === input.operationId))
      await decide(tx, ownerKey, ctx.headId, { kind: a.kind, normalized: a.normalized, assertionId: a.id, noteId: null, action: 'retract', reason: 'undo', supersededBy: null, reverts: null, by: by.author, operationId: op.id }, by);
    return { operationId: op.id, replayed: false };
  }
  if (input.action === 'retract') {
    const a = stored.assertions.find(x => x.id === input.assertionId);
    if (!a) return fail(404, 'field_not_found');
    await decide(tx, ownerKey, ctx.headId, { kind: a.kind, normalized: a.normalized, assertionId: a.id, noteId: null, action: 'retract', reason: input.reason, supersededBy: null, reverts: null, by: by.author, operationId: op.id }, by);
    return { operationId: op.id, replayed: false, key: valueKey(a.kind, a.normalized) };
  }
  if (input.action === 'dismiss') {
    const fields = projectFields(all, stored.decisions);
    const s = fieldSuggestions(ctx.notes, fields, stored.decisions).find(x => x.id === input.suggestionId);
    if (!s) return fail(404, 'suggestion_not_found');
    // Remembered per note, kind and normalised value (the suggestion id), so it never returns.
    await decide(tx, ownerKey, ctx.headId, { kind: s.kind, normalized: null, assertionId: null, noteId: s.noteId, action: 'dismiss', reason: s.id, supersededBy: null, reverts: null, by: by.author, operationId: op.id }, by);
    return { operationId: op.id, replayed: false };
  }
  const field = projectFields(all, stored.decisions).find(f => f.key === input.key);
  if (!field) return fail(404, 'field_not_found');
  await decide(tx, ownerKey, ctx.headId, { kind: field.kind, normalized: field.normalized, assertionId: null, noteId: null, action: input.action, reason: input.reason, supersededBy: null, reverts: null, by: by.author, operationId: op.id }, by);
  return { operationId: op.id, replayed: false, key: field.key };
}
