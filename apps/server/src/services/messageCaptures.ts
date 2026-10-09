/** Private source captures. Deliberately not Message/Thought nodes: ingest must
 * never join an external participant to OpenChat, notify them, or publish a tag. */
import { createHash, randomBytes } from 'node:crypto';
import type { Session } from 'neo4j-driver';

export class CaptureError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const fail = (message: string): never => { throw new CaptureError(400, message); };
const hash = (values: unknown[]) => createHash('sha256').update(JSON.stringify(values)).digest('hex');
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const string = (v: unknown, field: string, max: number, empty = false): string => {
  if (typeof v !== 'string' || (!empty && !v.trim()) || v.length > max) return fail(`Invalid ${field}`);
  return v;
};
const date = (v: unknown, field: string) => {
  const s = string(v, field, 40);
  if (!/^\d{4}-\d\d-\d\dT/.test(s) || !Number.isFinite(Date.parse(s))) return fail(`Invalid ${field}`);
  return new Date(s).toISOString();
};
const strings = (v: unknown, field: string, count: number, length: number) => {
  if (!Array.isArray(v) || v.length > count) return fail(`Invalid ${field}`);
  return [...new Set(v.map(x => string(x, field, length)))];
};

export interface CaptureInput {
  channel: 'imessage'; sourceAccount: string; sourceThreadId: string; threadTitle: string;
  participants: string[]; sourceMessageId: string; triggerMessageId: string; text: string;
  triggerText: string; sourceAt: string; capturedAt: string; tags: string[]; pinned: boolean;
  destination: 'stream'|'contact'|'note'; captureMethod: 'inline'|'reply'|'reaction'|'manual';
  contactDetails?: {fields:{label:string;value:string}[];modifiedAt:string};
}
export function parseCapture(raw: unknown): CaptureInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('Invalid capture');
  const r = raw as Record<string, unknown>;
  if (r.channel !== 'imessage') return fail('Unsupported source channel');
  if (typeof r.pinned !== 'boolean') return fail('Invalid pinned');
  if (!['stream','contact','note'].includes(String(r.destination))) return fail('Invalid destination');
  if (!['inline','reply','reaction','manual'].includes(String(r.captureMethod))) return fail('Invalid captureMethod');
  const tags = strings(r.tags, 'tags', 50, 256).map(t => t.normalize('NFKC').toLowerCase());
  if (tags.some(t => !/^[\p{L}\p{N}_][\p{L}\p{M}\p{N}_-]*$/u.test(t))) return fail('Invalid tag');
  let contactDetails:CaptureInput['contactDetails'];
  if(r.contactDetails!==undefined){
    const d=r.contactDetails as Record<string,unknown>;
    if(!d || typeof d!=='object' || !Array.isArray(d.fields)||d.fields.length>40 || JSON.stringify(d).length>16000) return fail('Invalid contact details');
    contactDetails={modifiedAt:date(d.modifiedAt,'contact modifiedAt'),fields:d.fields.map(f=>({label:string(f?.label,'contact label',80),value:string(f?.value,'contact value',2000)}))};
  }
  return {
    channel: 'imessage', sourceAccount: string(r.sourceAccount, 'sourceAccount', 200),
    sourceThreadId: string(r.sourceThreadId, 'sourceThreadId', 400), threadTitle: string(r.threadTitle, 'threadTitle', 200),
    participants: strings(r.participants, 'participants', 100, 200),
    sourceMessageId: string(r.sourceMessageId, 'sourceMessageId', 400), triggerMessageId: string(r.triggerMessageId, 'triggerMessageId', 1000),
    text: string(r.text, 'text', 256000), triggerText: string(r.triggerText, 'triggerText', 256000, true),
    sourceAt: date(r.sourceAt, 'sourceAt'), capturedAt: date(r.capturedAt, 'capturedAt'), tags,
    pinned: r.pinned, destination: r.destination as CaptureInput['destination'], captureMethod: r.captureMethod as CaptureInput['captureMethod'],...(contactDetails?{contactDetails}:{}),
  };
}
export function captureKeys(ownerId: string, c: CaptureInput) {
  const threadId = hash([ownerId,c.channel,c.sourceAccount,c.sourceThreadId]);
  return { threadId, id: hash([threadId,c.sourceMessageId]), eventId: hash([threadId,c.triggerMessageId]) };
}

export async function ingestCaptures(session: Session, ownerId: string, raw: unknown) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 25) return fail('Send between 1 and 25 captures');
  const captures = raw.map(parseCapture);
  await session.executeWrite(async tx => {
    // A deleted account cannot be recreated by a lingering device credential.
    if (!(await tx.run('MATCH (u:User {id:$ownerId}) RETURN u.id', {ownerId})).records.length) throw new CaptureError(401,'Account unavailable');
    for (const c of captures) {
      const keys = captureKeys(ownerId,c);
      await tx.run(`
        MERGE (thread:OpenChatCaptureThread {id:$threadId})
        ON CREATE SET thread.ownerId=$ownerId, thread.channel=$channel, thread.sourceAccount=$sourceAccount,
          thread.sourceThreadId=$sourceThreadId, thread.title=$threadTitle, thread.participants=$participants,
          thread.createdAt=$now, thread.visibility='private'
        WITH thread WHERE thread.ownerId=$ownerId
        FOREACH (_ IN CASE WHEN $contactDetails IS NOT NULL AND size($participants)=1 AND
          (thread.contactModifiedAt IS NULL OR thread.contactModifiedAt<=$contactModifiedAt) THEN [1] ELSE [] END |
          SET thread.contactDetailsJson=$contactDetails,thread.contactModifiedAt=$contactModifiedAt,thread.title=$threadTitle)
        MERGE (capture:OpenChatCapture {id:$id})
        ON CREATE SET capture.ownerId=$ownerId, capture.threadId=$threadId, capture.text=$text,
          capture.channel=$channel, capture.sourceMessageId=$sourceMessageId, capture.sourceAt=$sourceAt,
          capture.createdAt=$now, capture.capturedAt=$capturedAt, capture.tags=[], capture.pinned=false,
          capture.destination=$destination, capture.visibility='private', capture.events=[]
        WITH thread,capture WHERE capture.ownerId=$ownerId
        // A replay never resurrects a forgotten item or overwrites a user's pin choice.
        FOREACH (_ IN CASE WHEN capture.deletedAt IS NULL AND NOT $eventId IN capture.events THEN [1] ELSE [] END |
          SET capture.tags=reduce(tags=capture.tags,tag IN $tags | CASE WHEN tag IN tags THEN tags ELSE tags+tag END),
            capture.pinned=CASE WHEN $pinned THEN true ELSE capture.pinned END,
            capture.destination=CASE
              WHEN capture.destination='contact' OR $destination='contact' THEN 'contact'
              WHEN capture.destination='note' OR $destination='note' THEN 'note'
              ELSE 'stream' END,
            capture.events=capture.events+$eventId, capture.updatedAt=$now,
            capture.triggerText=$triggerText, capture.triggerMessageId=$triggerMessageId,
            capture.captureMethod=$captureMethod)
        MERGE (capture)-[:IN_CAPTURE_THREAD]->(thread)
      `, {...c,...keys,ownerId,now:new Date().toISOString(),contactDetails:c.contactDetails?JSON.stringify(c.contactDetails.fields):null,contactModifiedAt:c.contactDetails?.modifiedAt??null});
    }
  });
  return {accepted:captures.length};
}

export interface CaptureQuery { threadId?: string; search?: string; cursor?: string; limit?: number; destination?: string }
export async function listCaptures(session: Session, ownerId: string, options: CaptureQuery = {}) {
  const threadId = options.threadId || '', search = options.search || '', limit = options.limit ?? 50;
  if (threadId.length > 100 || search.length > 200 || !Number.isInteger(limit) || limit<1 || limit>100) return fail('Invalid query');
  const destination=options.destination||'';
  if(destination && !['stream','contact','note'].includes(destination)) return fail('Invalid destination');
  const scope = hash([ownerId,threadId,search,destination]);
  let cursor: {scope: string; pinned: boolean; at: string; id: string}|undefined;
  if (options.cursor) {
    try { cursor = JSON.parse(Buffer.from(options.cursor,'base64url').toString()); } catch { return fail('Invalid cursor'); }
    if (!cursor || cursor.scope!==scope || typeof cursor.pinned!=='boolean' || typeof cursor.at!=='string' || typeof cursor.id!=='string') return fail('Invalid cursor');
  }
  const result = await session.run(`
    MATCH (c:OpenChatCapture {ownerId:$ownerId})-[:IN_CAPTURE_THREAD]->(t:OpenChatCaptureThread {ownerId:$ownerId})
    WHERE c.deletedAt IS NULL AND ($threadId='' OR t.id=$threadId)
      AND ($destination='' OR c.destination=$destination)
      AND ($search='' OR toLower(c.text) CONTAINS toLower($search) OR toLower(t.title) CONTAINS toLower($search)
        OR any(tag IN c.tags WHERE toLower(tag) CONTAINS toLower($search)))
      AND ($cursorId='' OR (c.pinned=false AND $cursorPinned=true)
        OR (c.pinned=$cursorPinned AND (c.sourceAt<$cursorAt OR (c.sourceAt=$cursorAt AND c.id<$cursorId))))
    RETURN c,t.title AS threadTitle ORDER BY c.pinned DESC,c.sourceAt DESC,c.id DESC LIMIT toInteger($limit)
  `,{ownerId,threadId,destination,search:search.replace(/^#/,''),limit:limit+1,cursorId:cursor?.id || '',cursorAt:cursor?.at || '',cursorPinned:cursor?.pinned ?? false});
  const items = result.records.slice(0,limit).map(r => {
    const {events: _events, ...p} = r.get('c').properties;
    return {...p,threadTitle:r.get('threadTitle')};
  });
  const last = items.at(-1);
  return {items,...(last && result.records.length>limit ? {nextCursor:Buffer.from(JSON.stringify({scope,pinned:last.pinned,at:last.sourceAt,id:last.id})).toString('base64url')} : {})};
}

export async function addCapture(session: Session, ownerId: string, raw: unknown) {
  if(!raw || typeof raw!=='object' || Array.isArray(raw)) return fail('Invalid entry');
  const body=raw as Record<string,unknown>,text=string(body.text,'text',32000);
  const selected=body.threadId===undefined?'':string(body.threadId,'threadId',100,true);
  const destination=body.destination??'stream';
  if(!['stream','contact'].includes(String(destination))) return fail('Invalid destination');
  const contactLabel=destination==='contact'?string(body.contactLabel,'contact label',80):'';
  if(destination==='contact'&&!selected) return fail('Choose a person for contact details');
  const tags=strings(body.tags??[],'tags',50,256).map(t=>t.normalize('NFKC').toLowerCase());
  if(tags.some(t=>!/^[\p{L}\p{N}_][\p{L}\p{M}\p{N}_-]*$/u.test(t))) return fail('Invalid tag');
  if(body.pinned!==undefined&&typeof body.pinned!=='boolean')return fail('Invalid pinned');
  const threadId=selected||hash([ownerId,'personal']),id=randomBytes(24).toString('hex'),now=new Date().toISOString();
  await session.executeWrite(async tx=>{
    if(!(await tx.run('MATCH (u:User {id:$ownerId}) RETURN u.id',{ownerId})).records.length)throw new CaptureError(401,'Account unavailable');
    if(selected){
      const result=await tx.run('MATCH (t:OpenChatCaptureThread {id:$threadId,ownerId:$ownerId}) RETURN t.participants AS participants',{ownerId,threadId});
      if(!result.records.length)throw new CaptureError(404,'Stream not found');
      if(destination==='contact'&&(result.records[0].get('participants')||[]).length!==1)return fail('Choose an individual person for contact details');
    }else{
      await tx.run(`MERGE (t:OpenChatCaptureThread {id:$threadId}) ON CREATE SET t.ownerId=$ownerId,t.title='My notes',t.channel='manual',t.participants=[],t.visibility='private',t.createdAt=$now`,{ownerId,threadId,now});
    }
    await tx.run(`MATCH (t:OpenChatCaptureThread {id:$threadId,ownerId:$ownerId})
      CREATE (c:OpenChatCapture {id:$id,ownerId:$ownerId,threadId:$threadId,text:$text,channel:'manual',
        sourceAt:$now,capturedAt:$now,createdAt:$now,updatedAt:$now,tags:$tags,pinned:$pinned,
        destination:$destination,contactLabel:$contactLabel,visibility:'private',captureMethod:'direct',triggerText:'',events:[]})-[:IN_CAPTURE_THREAD]->(t)`,
      {ownerId,threadId,id,text,now,tags,pinned:body.pinned??false,destination,contactLabel});
  });
  return {id,threadId};
}

export async function listCaptureThreads(session: Session, ownerId: string) {
  const result = await session.run(`MATCH (t:OpenChatCaptureThread {ownerId:$ownerId})<-[:IN_CAPTURE_THREAD]-(c:OpenChatCapture {ownerId:$ownerId})
    WHERE c.deletedAt IS NULL RETURN t,count(c) AS count,max(c.sourceAt) AS lastSavedAt ORDER BY lastSavedAt DESC LIMIT 1000`,{ownerId});
  return result.records.map(r=>{const p={...r.get('t').properties};const contactDetails=p.contactDetailsJson?JSON.parse(p.contactDetailsJson):[];delete p.contactDetailsJson;return {...p,contactDetails,count:r.get('count').toNumber(),lastSavedAt:r.get('lastSavedAt')};});
}

export async function updateCapture(session: Session, ownerId: string, id: string, raw: unknown) {
  if (!raw || typeof raw!=='object' || Array.isArray(raw)) return fail('Invalid update');
  const body = raw as Record<string,unknown>, patch: Record<string,unknown> = {updatedAt:new Date().toISOString()};
  if (Object.keys(body).some(k=>!['pinned','tags'].includes(k)) || !Object.keys(body).length) return fail('Only pins and tags can change');
  if ('pinned' in body) {if (typeof body.pinned!=='boolean') return fail('Invalid pinned'); patch.pinned=body.pinned;}
  if ('tags' in body) {
    patch.tags=strings(body.tags,'tags',50,256).map(t=>t.normalize('NFKC').toLowerCase());
    if ((patch.tags as string[]).some(t=>!/^[\p{L}\p{N}_][\p{L}\p{M}\p{N}_-]*$/u.test(t))) return fail('Invalid tag');
  }
  const result = await session.run('MATCH (c:OpenChatCapture {id:$id,ownerId:$ownerId}) WHERE c.deletedAt IS NULL SET c += $patch RETURN c.id',{id,ownerId,patch});
  if (!result.records.length) throw new CaptureError(404,'Saved item not found');
  return {updated:true};
}

export async function forgetCapture(session: Session, ownerId: string, id: string) {
  const result = await session.run(`MATCH (c:OpenChatCapture {id:$id,ownerId:$ownerId})
    SET c={id:c.id,ownerId:c.ownerId,threadId:c.threadId,deletedAt:$now,visibility:'private'} RETURN c.id`,{id,ownerId,now:new Date().toISOString()});
  if (!result.records.length) throw new CaptureError(404,'Saved item not found');
  return {forgotten:true};
}

export async function createCaptureDevice(session: Session, ownerId: string, name: unknown) {
  const label=string(name,'device name',100),token='occ_'+randomBytes(32).toString('base64url'),id=randomBytes(16).toString('hex');
  const result=await session.run(`MATCH (u:User {id:$ownerId})
    CREATE (d:OpenChatCaptureDevice {id:$id,ownerId:$ownerId,name:$name,tokenHash:$tokenHash,createdAt:$now}) RETURN d.id`,{ownerId,id,name:label,tokenHash:tokenHash(token),now:new Date().toISOString()});
  if(!result.records.length) throw new CaptureError(401,'Account unavailable');
  return {id,name:label,token};
}
export async function authenticateCaptureDevice(session: Session, token: string) {
  if(!/^occ_[A-Za-z0-9_-]{43}$/.test(token)) throw new CaptureError(401,'Invalid companion credential');
  const result=await session.run(`MATCH (d:OpenChatCaptureDevice {tokenHash:$tokenHash}),(u:User {id:d.ownerId})
    WHERE d.revokedAt IS NULL SET d.lastSeenAt=$now RETURN d.ownerId AS ownerId`,{tokenHash:tokenHash(token),now:new Date().toISOString()});
  if(!result.records.length) throw new CaptureError(401,'Companion credential unavailable');
  return result.records[0].get('ownerId') as string;
}
