import { createHash } from 'node:crypto';
import type { ManagedTransaction } from 'neo4j-driver';
import { cleanName, cleanProvenance, cleanRequestId, fail, isId } from './contract.js';
import type { Provenance } from './contract.js';

/** Private source cards and People state live in the canonical overlay, never public profiles.
 * A source card is an assertion, not a shared identity. Exact source keys are idempotent;
 * attaching it to an existing entity requires an explicit, owner-scoped entity id.
 */
export interface ContactSource {
  source: string; sourceId: string; name: string | null; data: Record<string, unknown>; updatedAt: string; provenance: Provenance;
}
export interface PeopleState extends Provenance {
  schemaVersion: 1; revision: number; payload: Record<string, unknown>; updatedAt: string;
}
export const CONTACT_SOURCE_CONSTRAINT = 'CREATE CONSTRAINT overlay_contact_source IF NOT EXISTS FOR (s:OverlayContactSource) REQUIRE (s.ownerKey, s.sourceKey) IS UNIQUE';

export function contactInput(raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(400, 'invalid_contact');
  const input = raw as Record<string, unknown>;
  if (Object.keys(input).some(k => !['source', 'sourceId', 'name', 'data', 'entityId'].includes(k))) return fail(400, 'invalid_contact');
  const source = sourceIdentifier(input.source, 200), sourceId = sourceIdentifier(input.sourceId, 512);
  if (input.entityId !== undefined && !isId(input.entityId)) return fail(400, 'invalid_contact');
  return { source, sourceId, name: cleanName(input.name), data: contactJSON(input.data), entityId: input.entityId as string | undefined,
    sourceKey: createHash('sha256').update(JSON.stringify([source, sourceId])).digest('hex') };
}
function sourceIdentifier(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.length || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) return fail(400, 'invalid_contact');
  return value;
}
export function contactJSON(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || (raw as any).schemaVersion !== 1) return fail(400, 'invalid_contact');
  const encoded = JSON.stringify(raw);
  if (Buffer.byteLength(encoded) > 262144) return fail(413, 'contact_too_large');
  return JSON.parse(encoded) as Record<string, unknown>;
}

export async function sourcesIn(tx: ManagedTransaction, ownerKey: string, ids: string[]): Promise<Map<string, ContactSource[]>> {
  const rows = await tx.run('MATCH (s:OverlayContactSource {ownerKey:$ownerKey}) WHERE s.entityId IN $ids RETURN s.entityId AS id, s { .source, .sourceId, .name, .data, .updatedAt, .author, .sourceVia, .assertion } AS value ORDER BY s.sourceKey', { ownerKey, ids });
  const result = new Map<string, ContactSource[]>();
  for (const row of rows.records) {
    const value = row.get('value') as any, id = String(row.get('id'));
    const source: ContactSource = { source: value.source, sourceId: value.sourceId, name: value.name ?? null, data: JSON.parse(value.data), updatedAt: value.updatedAt,
      provenance: { author: value.author ?? null, source: value.sourceVia ?? null, assertion: value.assertion ?? null } };
    result.set(id, [...(result.get(id) ?? []), source]);
  }
  return result;
}

export function stateFrom(raw: unknown): PeopleState | undefined {
  return typeof raw === 'string' ? JSON.parse(raw) as PeopleState : undefined;
}
export function stateInput(raw: unknown, by: unknown): { operationId: string; expectedRevision: number; payload: Record<string, unknown>; provenance: Provenance } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(400, 'invalid_contact');
  const input = raw as any;
  if (Object.keys(input).some(k => !['operationId', 'expectedRevision', 'payload'].includes(k)) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) return fail(400, 'invalid_contact');
  return { operationId: cleanRequestId(input.operationId), expectedRevision: input.expectedRevision, payload: contactJSON(input.payload), provenance: cleanProvenance(by) };
}

/** Canonical card properties are also updated so other authorized overlay views
 * see cadence/importance; the versioned payload retains native-specific fields. */
export function stateCard(raw: unknown): Record<string,unknown> | null {
  if (raw === undefined) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(400,'invalid_card');
  const card=raw as any;
  if (typeof card.important !== 'boolean' || !['fixed','expanding'].includes(card.cadenceMode)) return fail(400,'invalid_card');
  for (const key of ['cadenceDays','intervalDays']) if (card[key] !== null && (!Number.isInteger(card[key]) || card[key]<1 || card[key]>3650)) return fail(400,'invalid_card');
  for (const key of ['lastContactAt','nextDueAt']) if (card[key] !== null && (typeof card[key] !== 'string' || !Number.isFinite(Date.parse(card[key])))) return fail(400,'invalid_card');
  return {important:card.important,cadenceMode:card.cadenceMode,cadenceDays:card.cadenceDays,intervalDays:card.intervalDays,lastContactAt:card.lastContactAt,explicitNextDueAt:card.nextDueAt};
}

export function stableJSON(value: unknown): string {
  if (Array.isArray(value)) return '['+value.map(stableJSON).join(',')+']';
  if (value && typeof value === 'object') return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stableJSON((value as Record<string,unknown>)[k])).join(',')+'}';
  return JSON.stringify(value);
}
