/** Blurbs v2. All mutation helpers run inside the same owner-clock transaction. */
import { createHash } from 'node:crypto';
import type { ManagedTransaction } from 'neo4j-driver';
import { EMPTY_CARD, fail as overlayFail, isOwnerKey, nameKey } from './contract.js';

function fail(status: number, code: string): never { return overlayFail(status, code); }
type Runner = Pick<ManagedTransaction, 'run'>;
export const BLURB_LIMITS = { bodyGraphemes: 20000, bodyBytes: 100000, variants: 32, versions: 1000, blurbs: 500, candidates: 1000, ownerBytes: 16 * 1024 * 1024, page: 100, blurbBytes: 1024 * 1024, ledgerBytes: 64 * 1024 * 1024, operations: 10000 };
type Obj = Record<string, any>;
export interface BlurbVersion { id: string; text: string; createdAt: string; source: string; restoredFromVersionId?: string; sourceRef?: string; sourceRevision?: string; sourceCreatedAt?: string; sourceModifiedAt?: string; importedAt?: string }
export interface BlurbVariant { id: string; label: string; position: number; shortcut?: string; versions: BlurbVersion[] }
export interface Blurb { id: string; title: string; shortcut?: string; tags: string[]; pinned: boolean; deletedAt?: string | null; variants: BlurbVariant[]; defaultVariantId: string; editedAt: string }
export interface BlurbState { blurbs: Blurb[]; candidates: Obj[]; conflicts: Obj[]; usage: Record<string, { count: number; lastCopiedAt: string }> }
const empty = (): BlurbState => ({ blurbs: [], candidates: [], conflicts: [], usage: {} });
export function uuid(v: unknown): string { return typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v) ? v.toLowerCase() : fail(400, 'invalid_uuid'); }
function object(v: unknown): Obj { return v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : fail(400, 'invalid_blurb_command'); }
function keys(v: Obj, allowed: string[]) { if (Object.keys(v).some(k => !allowed.includes(k))) fail(400, 'invalid_blurb_command'); }
function string(v: unknown, max: number, optional = false): string | undefined { if (optional && v === undefined) return undefined; return typeof v === 'string' && v.length <= max ? v : fail(400, 'invalid_blurb_text'); }
function instant(v: unknown): string { return typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : fail(400, 'invalid_instant'); }
export function bodyText(v: unknown): string {
  if (typeof v !== 'string' || !v.length || Buffer.byteLength(v, 'utf8') > BLURB_LIMITS.bodyBytes || [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(v)].length > BLURB_LIMITS.bodyGraphemes || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v)) return fail(400, 'invalid_blurb_text');
  return v; // Never trim, normalize, or remove whitespace/control characters.
}
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Obj)[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}
export const digest = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
export function parseBlurb(v: unknown): Blurb {
  const b = object(v); keys(b, ['id', 'title', 'shortcut', 'tags', 'pinned', 'deletedAt', 'variants', 'defaultVariantId', 'editedAt']);
  const id = uuid(b.id), title = string(b.title, 280)!;
  if (!title.trim() || typeof b.pinned !== 'boolean' || !Array.isArray(b.tags) || b.tags.length > 100 || !Array.isArray(b.variants) || !b.variants.length || b.variants.length > BLURB_LIMITS.variants) fail(400, 'invalid_blurb');
  const ids = new Set<string>([id]);
  const unique = (v: unknown) => { const next = uuid(v); if (ids.has(next)) fail(409, 'id_reused'); ids.add(next); return next; };
  const variants: BlurbVariant[] = b.variants.map((raw: unknown) => {
    const a = object(raw); keys(a, ['id', 'label', 'position', 'shortcut', 'versions']);
    if (!Number.isSafeInteger(a.position) || a.position < 0 || !Array.isArray(a.versions) || !a.versions.length || a.versions.length > BLURB_LIMITS.versions) fail(400, 'invalid_variant');
    return { id: unique(a.id), label: string(a.label, 280)!, position: a.position, ...(a.shortcut === undefined ? {} : { shortcut: string(a.shortcut, 100)! }), versions: a.versions.map((raw: unknown) => {
      const x = object(raw); keys(x, ['id','text','chars','words','createdAt','source','restoredFromVersionId','sourceRef','sourceRevision','sourceCreatedAt','sourceModifiedAt','importedAt']);
      const version: BlurbVersion = { id: unique(x.id), text: bodyText(x.text), createdAt: instant(x.createdAt), source: string(x.source, 80)! };
      if (x.restoredFromVersionId !== undefined) version.restoredFromVersionId = uuid(x.restoredFromVersionId);
      for (const k of ['sourceRef','sourceRevision'] as const) if (x[k] !== undefined) version[k] = string(x[k], 1000)!;
      for (const k of ['sourceCreatedAt','sourceModifiedAt','importedAt'] as const) if (x[k] !== undefined) version[k] = instant(x[k]);
      return version;
    }) };
  });
  const defaultVariantId = uuid(b.defaultVariantId); if (!variants.some(v => v.id === defaultVariantId)) fail(400, 'invalid_default_variant');
  const result: Blurb = { id, title, ...(b.shortcut === undefined ? {} : { shortcut: string(b.shortcut, 100)! }), tags: [...new Set<string>(b.tags.map((t: unknown) => nameKey(string(t, 100)!)))].sort(), pinned: b.pinned, ...(b.deletedAt == null ? { deletedAt: null } : { deletedAt: instant(b.deletedAt) }), variants, defaultVariantId, editedAt: instant(b.editedAt) };
  if(Buffer.byteLength(JSON.stringify(result))>BLURB_LIMITS.blurbBytes) fail(413,'blurb_history_quota_exceeded');
  return result;
}
export function blurbTags(b: Blurb): Array<{ tag: string; origin: 'explicit' | 'derived' }> {
  const derived = [...new Set(b.variants.flatMap(v => [...v.versions.at(-1)!.text.matchAll(/(?<![\p{L}\p{N}_])#([\p{L}\p{N}_]+)/gu)].map(m => m[1].toLowerCase())))];
  return [...b.tags.map(tag => ({ tag, origin: 'explicit' as const })), ...derived.map(tag => ({ tag, origin: 'derived' as const }))];
}
export function shelf(state: BlurbState, q = '') {
  const query = nameKey(q);
  return state.blurbs.filter(b => !b.deletedAt).flatMap(b => b.variants.map(v => ({ id: b.id, title: b.title, pinned: b.pinned, defaultVariantId: b.defaultVariantId, variantId: v.id, label: v.label, shortcut: v.shortcut ?? b.shortcut, version: v.versions.at(-1)!, tags: [...new Set(blurbTags(b).map(t => t.tag))], editedAt: b.editedAt })))
    .filter(x => !query || nameKey([x.title, x.label, x.shortcut, x.version.text, ...x.tags].join(' ')).includes(query))
    .sort((a,b) => Number(nameKey(b.shortcut ?? '') === query || nameKey(b.title) === query) - Number(nameKey(a.shortcut ?? '') === query || nameKey(a.title) === query) || Number(b.pinned) - Number(a.pinned) || a.id.localeCompare(b.id) || a.variantId.localeCompare(b.variantId));
}
/** Pure transition; persistence/receipt/sequence commit atomically around this function. */
export function applyBlurb(state: BlurbState, raw: unknown, now: string): Obj {
  const c = object(raw); keys(c, ['operationId','type','payload','baseVersionId','baseVersionIds','expectedRevision','targetID','candidateId','action','conflictId','variantId']);
  const operationId = uuid(c.operationId);
  if (state.conflicts.length >= 1000 && c.type === 'save') fail(413,'conflict_quota_exceeded');
  if(c.type==='resolve_conflict') {
    const conflict=state.conflicts.find(x=>x.id===uuid(c.conflictId));
    if(!conflict) fail(404,'conflict_not_found');
    if(!['keep_current','recovered'].includes(c.action)) fail(400,'invalid_resolution');
    if(c.action==='recovered' && !state.blurbs.some(b=>b.id===uuid(c.targetID)&&!b.deletedAt)) fail(404,'recovery_not_found');
    conflict.resolvedAt=now; conflict.resolution=c.action; conflict.recoveredBlurbId=c.action==='recovered'?uuid(c.targetID):null;
    return {status:'resolved',conflictId:conflict.id};
  }
  if (c.type === 'save') {
    const b = parseBlurb(c.payload); if (c.targetID !== undefined && uuid(c.targetID) !== b.id) fail(400, 'target_mismatch');
    const old = state.blurbs.find(x => x.id === b.id);
    // IDs are immutable and cannot move between parents, including dismissed candidates/conflicts.
    const incoming = b.variants.flatMap(v => [v.id, ...v.versions.map(x => x.id)]);
    for (const other of state.blurbs.filter(x => x.id !== b.id)) if ([other.id, ...other.variants.flatMap(v => [v.id,...v.versions.map(x=>x.id)])].some(id => id === b.id || incoming.includes(id))) fail(409, 'id_reused');
    const base = c.baseVersionIds ?? (c.baseVersionId == null ? [] : [c.baseVersionId]);
    if (!Array.isArray(base)) fail(400, 'invalid_base');
    const bases = base.map(uuid).sort();
    if (new Set(bases).size !== bases.length) fail(400, 'invalid_base');
    const current = old?.variants.map(v => v.versions.at(-1)!.id).sort() ?? [];
    const revision = old ? digest(old) : null;
    const metadata = (x: Blurb) => ({...x, variants:x.variants.map(v=>({...v,versions:[]})), editedAt:undefined});
    if ((old?.deletedAt && !b.deletedAt) || canonical(bases) !== canonical(current) || (c.expectedRevision !== undefined && c.expectedRevision !== revision)) {
      const conflict = { id: operationId, blurbId: b.id, payload: b, baseVersionIds: bases, currentVersionIds: current, reason: old?.deletedAt ? 'deleted' : 'stale_base', createdAt: now, resolvedAt: null };
      state.conflicts.push(conflict); return { status: 'conflict', conflict, recovery: 'Save recovered text under a new blurb ID, or resolve against the current base. Deleted content is never resurrected.' };
    }
    if (old && digest(metadata(old)) !== digest(metadata(b)) && c.expectedRevision === undefined) fail(400,'expected_revision_required');
    if (old?.deletedAt && canonical(old) !== canonical(b)) fail(409,'deleted_blurb');
    if (old) for (const v of old.variants) {
      const next = b.variants.find(x => x.id === v.id);
      if (!next || canonical(next.versions.slice(0, v.versions.length)) !== canonical(v.versions)) fail(409, 'immutable_history');
    }
    for (const v of b.variants) for (let i=0;i<v.versions.length;i++) {
      const x = v.versions[i];
      if (i>0 && v.versions[i-1].text===x.text && !x.restoredFromVersionId) fail(400,'unchanged_version');
      if (x.restoredFromVersionId) {
        const historical = v.versions.slice(0,i).find(p => p.id === x.restoredFromVersionId);
        if (!historical || historical.text !== x.text) fail(400, 'invalid_restore');
      }
    }
    const unchanged=old && canonical(old)===canonical(b);
    if(unchanged && c.conflictId===undefined) return {status:'unchanged',blurbId:b.id,revision};
    if (old) state.blurbs[state.blurbs.indexOf(old)] = b; else state.blurbs.push(b);
    if (c.conflictId !== undefined) {
      const conflict = state.conflicts.find(x => x.id === uuid(c.conflictId) && x.blurbId === b.id);
      if (!conflict) fail(404, 'conflict_not_found'); conflict.resolvedAt = now;
    }
    return { status: 'saved', blurbId: b.id, revision: digest(b) };
  }
  if (c.type === 'copied') {
    const variantId = uuid(c.variantId), targetID = uuid(c.targetID);
    const b = state.blurbs.find(x => x.id === targetID && !x.deletedAt);
    if (!b?.variants.some(v => v.id === variantId)) fail(404, 'not_found');
    const prior = state.usage[variantId]; state.usage[variantId] = { count: (prior?.count ?? 0) + 1, lastCopiedAt: now };
    return { status: 'copied', blurbId: targetID, variantId, usage: state.usage[variantId] };
  }
  if (c.type === 'import') {
    const p = object(c.payload); keys(p, ['id','provider','account','sourceId','sourceRevision','text','sourceCreatedAt','sourceModifiedAt']);
    const source = ['provider','account','sourceId','sourceRevision'].map(k => string(p[k],1000)!);
    if (source.some(s=>!s)) fail(400,'invalid_source');
    const sourceKey = digest(source.slice(0,3)), observationKey = digest(source);
    const existing = state.candidates.find(x => x.observationKey === observationKey);
    if(typeof p.text!=='string' || Buffer.byteLength(p.text)>BLURB_LIMITS.blurbBytes) fail(413,'candidate_request_too_large');
    const text=p.text; let limitError: string | null=null;
    try { bodyText(text); } catch { limitError='invalid_blurb_text'; }
    if (existing) { if (existing.text !== text) fail(409,'source_revision_reused'); return { status:'unchanged', candidateId:existing.id }; }
    const id = uuid(p.id); if (state.candidates.some(x=>x.id===id)) fail(409,'id_reused');
    const updated = state.candidates.some(x=>x.sourceKey===sourceKey);
    const candidate = { id, sourceKey, observationKey, provider:source[0], account:source[1], sourceId:source[2], sourceRevision:source[3], text, limitError, sourceCreatedAt: p.sourceCreatedAt == null ? null : instant(p.sourceCreatedAt), sourceModifiedAt:p.sourceModifiedAt == null ? null : instant(p.sourceModifiedAt), importedAt:now, status:'new', sourceUpdated:updated };
    state.candidates.push(candidate); return { status:'imported', candidateId:id, limitError };
  }
  if (c.type === 'review') {
    const candidate = state.candidates.find(x=>x.id===uuid(c.candidateId)); if (!candidate) fail(404,'not_found');
    if(candidate.limitError && c.action!=='dismiss') fail(413,'candidate_text_limit');
    if (candidate.status !== 'new') fail(409,'already_reviewed');
    if (!['create','alternative','history','dismiss'].includes(c.action)) fail(400,'invalid_review_action');
    if (c.action !== 'dismiss') {
      const before = state.blurbs.find(x=>x.id===object(c.payload).id);
      const result = applyBlurb(state, { operationId, type:'save', payload:c.payload, baseVersionIds:c.baseVersionIds, expectedRevision:c.expectedRevision }, now);
      if (result.status === 'conflict') return result; // Candidate stays unreviewed until an actual adoption succeeds.
      const after = state.blurbs.find(x=>x.id===result.blurbId)!;
      if (c.action === 'create' && before || c.action !== 'create' && !before) fail(409,'invalid_promotion_target');
      const added = after.variants.flatMap(v => v.versions.filter(x => !before?.variants.some(a=>a.versions.some(p=>p.id===x.id))));
      if (!added.some(x=>x.text===candidate.text && x.sourceRef===candidate.sourceKey && x.sourceRevision===candidate.sourceRevision)) fail(400,'missing_candidate_provenance');
      if(c.action==='alternative') {
        const newVariants=after.variants.filter(v=>!before!.variants.some(old=>old.id===v.id));
        if(!newVariants.some(v=>v.versions.some(x=>x.text===candidate.text&&x.sourceRef===candidate.sourceKey&&x.sourceRevision===candidate.sourceRevision)) ||
          before!.variants.some(v=>canonical(v.versions)!==canonical(after.variants.find(x=>x.id===v.id)!.versions)) || after.defaultVariantId!==before!.defaultVariantId) fail(400,'alternative_required');
      }
      if (c.action === 'history') fail(400,'use_attach_history');
      candidate.blurbId = after.id;
    }
    candidate.status = c.action === 'dismiss' ? 'dismissed' : 'promoted'; candidate.action=c.action; candidate.reviewedAt=now;
    return { status:'reviewed', candidateId:candidate.id, blurbId:candidate.blurbId ?? null };
  }
  if (c.type === 'attach_history') {
    const candidate = state.candidates.find(x=>x.id===uuid(c.candidateId));
    const b = state.blurbs.find(x=>x.id===uuid(c.targetID) && !x.deletedAt);
    if (!candidate || !b) fail(404,'not_found'); if (candidate.status!=='new') fail(409,'already_reviewed');
    if(candidate.limitError) fail(413,'candidate_text_limit');
    candidate.status='promoted'; candidate.action='history'; candidate.blurbId=b.id; candidate.reviewedAt=now;
    return { status:'reviewed', candidateId:candidate.id, blurbId:b.id };
  }
  fail(400, 'invalid_blurb_command');
}

export const BLURB_CONSTRAINTS = [
  'CREATE CONSTRAINT overlay_blurb_clock IF NOT EXISTS FOR (n:OverlayBlurbClock) REQUIRE n.ownerKey IS UNIQUE',
  'CREATE CONSTRAINT overlay_blurb_operation IF NOT EXISTS FOR (n:OverlayBlurbOperation) REQUIRE (n.ownerKey,n.operationId) IS UNIQUE',
  'CREATE CONSTRAINT overlay_blurb_record IF NOT EXISTS FOR (n:OverlayBlurbRecord) REQUIRE (n.ownerKey,n.key) IS UNIQUE',
  'CREATE CONSTRAINT overlay_blurb_change IF NOT EXISTS FOR (n:OverlayBlurbChange) REQUIRE (n.ownerKey,n.sequence) IS UNIQUE',
  'CREATE CONSTRAINT overlay_blurb_version IF NOT EXISTS FOR (n:OverlayBlurbVersion) REQUIRE (n.ownerKey,n.id) IS UNIQUE',
  'CREATE CONSTRAINT overlay_blurb_variant IF NOT EXISTS FOR (n:OverlayBlurbVariant) REQUIRE (n.ownerKey,n.id) IS UNIQUE',
  'CREATE CONSTRAINT overlay_blurb_tag IF NOT EXISTS FOR (n:OverlayBlurbTag) REQUIRE (n.ownerKey,n.name) IS UNIQUE',
];
export async function loadBlurbs(tx: Runner, ownerKey: string): Promise<BlurbState> {
  const rows = await tx.run('MATCH (n:OverlayBlurbRecord {ownerKey:$ownerKey}) RETURN n.key AS key, n.json AS json ORDER BY n.key', {ownerKey});
  const state = empty();
  for (const row of rows.records) {
    const key = row.get('key') as string, value = JSON.parse(row.get('json'));
    if (key.startsWith('blurb:')) state.blurbs.push(value); else if (key.startsWith('candidate:')) state.candidates.push(value); else if (key.startsWith('conflict:')) state.conflicts.push(value); else if (key==='usage') state.usage=value;
  }
  return state;
}
function records(s: BlurbState): Map<string,string> { return new Map([...s.blurbs.map(x=>[`blurb:${x.id}`,JSON.stringify(x)]), ...s.candidates.map(x=>[`candidate:${x.id}`,JSON.stringify(x)]), ...s.conflicts.map(x=>[`conflict:${x.id}`,JSON.stringify(x)]), ['usage',JSON.stringify(s.usage)]] as [string,string][]); }
export async function mutateBlurbIn(tx: Runner, ownerKey: string, raw: unknown): Promise<Obj> {
  if (!isOwnerKey(ownerKey)) fail(401,'authentication_required');
  const c=object(raw), operationId=uuid(c.operationId), payloadDigest=digest(c);
  // All owner mutations, including receipt checks and sequence allocation, serialize here.
  await tx.run('MERGE (c:OverlayBlurbClock {ownerKey:$ownerKey}) ON CREATE SET c.sequence=0,c.ledgerBytes=0,c.operations=0 SET c._lock=true REMOVE c._lock', {ownerKey});
  const receipt=await tx.run('MATCH (o:OverlayBlurbOperation {ownerKey:$ownerKey,operationId:$operationId}) RETURN o.digest AS digest,o.result AS result',{ownerKey,operationId});
  if (receipt.records.length) { if(receipt.records[0].get('digest')!==payloadDigest) fail(409,'operation_id_reused'); return JSON.parse(receipt.records[0].get('result')); }
  if (c.type === 'save' || c.type === 'review' && c.payload) {
    const b=parseBlurb(c.payload);
    const collision=await tx.run('MATCH (e:OverlayEntity {id:$id}) WHERE e.ownerKey <> $ownerKey OR e.kind <> \'blurb\' RETURN count(e) AS count',{id:b.id,ownerKey});
    if(Number(collision.records[0].get('count'))) fail(409,'id_reused');
  }
  const clock=await tx.run('MATCH (c:OverlayBlurbClock {ownerKey:$ownerKey}) RETURN coalesce(c.ledgerBytes,0) AS bytes,coalesce(c.operations,0) AS operations',{ownerKey});
  if(Number(clock.records[0].get('operations'))>=BLURB_LIMITS.operations) fail(413,'blurb_operation_quota_exceeded');
  const state=await loadBlurbs(tx,ownerKey), before=records(state), now=new Date().toISOString();
  const result=applyBlurb(state,c,now), after=records(state);
  if(state.blurbs.length>BLURB_LIMITS.blurbs || state.candidates.length>BLURB_LIMITS.candidates || [...after.values()].reduce((n,s)=>n+Buffer.byteLength(s),0)>BLURB_LIMITS.ownerBytes) fail(413,'blurb_quota_exceeded');
  const changes=[...after].filter(([key,json])=>before.get(key)!==json).map(([key,json])=>({key,json}));
  let eventBytes=0, graphBytes=0;
  let sequence:number;
  if(changes.length) {
    const counter=await tx.run('MATCH (c:OverlayBlurbClock {ownerKey:$ownerKey}) SET c.sequence=c.sequence+1 RETURN c.sequence AS sequence',{ownerKey}); sequence=Number(counter.records[0].get('sequence'));
    await tx.run("UNWIND $changes AS row MERGE (n:OverlayBlurbRecord {ownerKey:$ownerKey,key:row.key}) ON CREATE SET n.createdSequence=$sequence,n.initialJson=CASE WHEN row.key STARTS WITH 'candidate:' THEN row.json ELSE null END SET n.json=row.json,n.sequence=$sequence",{ownerKey,changes,sequence});
    const event={ type:c.type, changed:changes.map(x=>x.key), tombstones:state.blurbs.filter(b=>b.deletedAt && changes.some(x=>x.key===`blurb:${b.id}`)).map(b=>({id:b.id,variantIds:b.variants.map(v=>v.id),deletedAt:b.deletedAt})), result: {status:result.status,blurbId:result.blurbId ?? null,candidateId:result.candidateId ?? null} };
    eventBytes=Buffer.byteLength(JSON.stringify(event));
    await tx.run('CREATE (:OverlayBlurbChange {ownerKey:$ownerKey,sequence:$sequence,json:$json,createdAt:$now})',{ownerKey,sequence,json:JSON.stringify(event),now});
    for(const b of state.blurbs.filter(b=>changes.some(x=>x.key===`blurb:${b.id}`))) {
      await tx.run("MERGE (e:OverlayEntity {ownerKey:$ownerKey,id:$id}) ON CREATE SET e.kind='blurb',e.createdAt=$now SET e.name=$title,e.nameKey=$nameKey,e.updatedAt=$now,e.deletedAt=$deletedAt,e.deletedSequence=CASE WHEN $deletedAt IS NULL THEN null ELSE coalesce(e.deletedSequence,$sequence) END",{ownerKey,id:b.id,title:b.title,nameKey:nameKey(b.title),deletedAt:b.deletedAt??null,sequence,now});
      for(const v of b.variants) {
        await tx.run('MATCH (b:OverlayEntity {ownerKey:$ownerKey,id:$blurbId}) MERGE (v:OverlayBlurbVariant {ownerKey:$ownerKey,id:$id}) SET v.blurbId=$blurbId,v.label=$label,v.position=$position,v.currentVersionId=$currentVersionId MERGE (b)-[:HAS_VARIANT]->(v)',{ownerKey,blurbId:b.id,id:v.id,label:v.label,position:v.position,currentVersionId:v.versions.at(-1)!.id});
        const previous=before.get(`blurb:${b.id}`);
        const previousIds=new Set(previous ? (JSON.parse(previous) as Blurb).variants.flatMap(v=>v.versions.map(x=>x.id)) : []);
        const versions=v.versions.filter(x=>!previousIds.has(x.id)).map(x=>({...x,variantId:v.id,blurbId:b.id,serverSequence:sequence}));
        graphBytes+=Buffer.byteLength(JSON.stringify(versions));
        if(versions.length) await tx.run('MATCH (v:OverlayBlurbVariant {ownerKey:$ownerKey,id:$variantId}) UNWIND $versions AS props CREATE (h:OverlayBlurbVersion) SET h=props,h.ownerKey=$ownerKey MERGE (v)-[:HAS_VERSION]->(h)',{ownerKey,variantId:v.id,versions});
      }
      await tx.run('MATCH (b:OverlayEntity {ownerKey:$ownerKey,id:$id})-[r:has_tag]->(:OverlayBlurbTag {ownerKey:$ownerKey}) DELETE r',{ownerKey,id:b.id});
      if(!b.deletedAt) for(const t of blurbTags(b)) await tx.run('MATCH (b:OverlayEntity {ownerKey:$ownerKey,id:$id}) MERGE (t:OverlayBlurbTag {ownerKey:$ownerKey,name:$tag}) MERGE (b)-[:has_tag {origin:$origin}]->(t)',{ownerKey,id:b.id,...t});
    }
  } else { const r=await tx.run('MATCH (c:OverlayBlurbClock {ownerKey:$ownerKey}) RETURN c.sequence AS sequence',{ownerKey}); sequence=Number(r.records[0].get('sequence')); }
  const response={...result,sequence};
  const recordGrowth=changes.reduce((n,x)=>n+Buffer.byteLength(x.json)-Buffer.byteLength(before.get(x.key)??'')+(x.key.startsWith('candidate:')&&!before.has(x.key)?Buffer.byteLength(x.json):0),0);
  const bytes=Number(clock.records[0].get('bytes'))+recordGrowth+graphBytes+eventBytes+Buffer.byteLength(JSON.stringify(response))+256;
  if(bytes>BLURB_LIMITS.ledgerBytes) fail(413,'blurb_ledger_quota_exceeded');
  await tx.run('MATCH (c:OverlayBlurbClock {ownerKey:$ownerKey}) SET c.ledgerBytes=$bytes,c.operations=coalesce(c.operations,0)+1',{ownerKey,bytes});
  await tx.run('CREATE (:OverlayBlurbOperation {ownerKey:$ownerKey,operationId:$operationId,digest:$payloadDigest,result:$result,createdAt:$now})',{ownerKey,operationId,payloadDigest,result:JSON.stringify(response),now});
  return response;
}
export function pageLimit(v: unknown): number { if(v===undefined) return 50; const n=Number(v); return Number.isInteger(n)&&n>0&&n<=BLURB_LIMITS.page?n:fail(400,'invalid_limit'); }
export function sequenceCursor(v: unknown): number { if(v===undefined) return 0; return typeof v==='string'&&/^(0|[1-9][0-9]*)$/.test(v)&&Number.isSafeInteger(Number(v))?Number(v):fail(400,'invalid_cursor'); }
export async function changesIn(tx:Runner,ownerKey:string,cursor:unknown,limit:unknown) {
  const after=sequenceCursor(cursor), size=pageLimit(limit);
  const rows=await tx.run('MATCH (n:OverlayBlurbChange {ownerKey:$ownerKey}) WHERE n.sequence>$after RETURN n.sequence AS sequence,n.json AS json ORDER BY n.sequence LIMIT toInteger($limit)',{ownerKey,after,limit:size+1});
  const changes=rows.records.slice(0,size).map(r=>({sequence:Number(r.get('sequence')),...JSON.parse(r.get('json'))}));
  return {changes,nextCursor:String(changes.at(-1)?.sequence??after),hasMore:rows.records.length>size};
}
export const blurbCard = EMPTY_CARD;

/** Immutable server-order feed: cursor freezes a high-water mark and uses a (sequence,key) seek. */
export async function blurbFeedIn(tx: Runner, ownerKey: string, rawCursor: unknown, rawLimit: unknown) {
  const limit=pageLimit(rawLimit);
  let after=0,key='',through:number;
  if(rawCursor===undefined) {
    const r=await tx.run('MATCH (c:OverlayBlurbClock {ownerKey:$ownerKey}) RETURN c.sequence AS sequence',{ownerKey}); through=Number(r.records[0]?.get('sequence')??0);
  } else {
    if(typeof rawCursor!=='string'||rawCursor.length>1000) fail(400,'invalid_cursor');
    let c:Obj; try{c=JSON.parse(Buffer.from(rawCursor as string,'base64url').toString());}catch{return fail(400,'invalid_cursor');}
    if(c.ownerKey!==ownerKey||!Number.isSafeInteger(c.after)||!Number.isSafeInteger(c.through)||c.after<0||c.through<c.after||typeof c.key!=='string') fail(400,'invalid_cursor');
    after=c.after;key=c.key;through=c.through;
  }
  const rows=await tx.run(`CALL {
    MATCH (v:OverlayBlurbVersion {ownerKey:$ownerKey}) MATCH (b:OverlayEntity {ownerKey:$ownerKey,id:v.blurbId}) WHERE b.deletedAt IS NULL OR b.deletedSequence > $through
    RETURN v.serverSequence AS sequence,'version:'+v.id AS key,'version' AS type,properties(v) AS value
    UNION ALL
    MATCH (c:OverlayBlurbRecord {ownerKey:$ownerKey}) WHERE c.key STARTS WITH 'candidate:'
    RETURN c.createdSequence AS sequence,c.key AS key,'candidate' AS type,{json:coalesce(c.initialJson,c.json)} AS value
  } WITH sequence,key,type,value WHERE sequence <= $through AND (sequence > $after OR (sequence=$after AND key>$key))
  RETURN sequence,key,type,value ORDER BY sequence,key LIMIT toInteger($limit)`,{ownerKey,after,key,through,limit:limit+1});
  const items=rows.records.slice(0,limit).map(r=>{const value=r.get('value'); if(value.ownerKey) delete value.ownerKey; return {sequence:Number(r.get('sequence')),key:r.get('key'),type:r.get('type'),value:value.json?JSON.parse(value.json):value};});
  const last=items.at(-1);
  return {items,nextCursor: rows.records.length>limit&&last?Buffer.from(JSON.stringify({ownerKey,after:last.sequence,key:last.key,through})).toString('base64url'):null};
}
