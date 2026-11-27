// Runs on the paired Mac. No token discovery, database access, writes, redirects,
// remote origin, arbitrary paths, attachment fetches or source-body logging.
import { createHmac } from 'node:crypto';

export class BeeperApiError extends Error {
  constructor(code) { super(({authorization_required:'Approve a read-only Beeper connection on this Mac.',unavailable:'Beeper Desktop is unavailable on this Mac.',incompatible:'This Beeper API response needs review.'})[code]); this.code=code; }
}
const bad=()=>{throw new BeeperApiError('incompatible');};
const identifier=value=>typeof value==='string'&&value.length>0&&value.length<=2000&&!/[\u0000-\u001f\u007f]/u.test(value)&&!['.','..'].includes(value)?value:bad();
const date=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
const text=(value,max,required=false)=>{
  if(value===undefined||value===null){if(required)bad();return null;}
  if(typeof value!=='string'||value.length>max||(required&&!value.trim()))bad();return value;
};

/** Stable identity key is held on the Mac, separately from API/grant secrets.
 * @param {Uint8Array} identityKey @param {string} domain @param {string[]} parts
 */
export function opaqueBeeperKey(identityKey,domain,...parts){
  if(!(identityKey instanceof Uint8Array)||identityKey.byteLength<32)bad();
  return createHmac('sha256',identityKey).update(JSON.stringify([domain,...parts])).digest('hex');
}

/** @typedef {{items:Record<string,unknown>[],hasMore:boolean,newestCursor?:string,oldestCursor?:string}} Page */
function page(value){
  if(!value||!Array.isArray(value.items)||typeof value.hasMore!=='boolean'||value.items.length>2000)bad();
  for(const cursor of [value.newestCursor,value.oldestCursor])if(cursor!==undefined)identifier(cursor);
  return value;
}

/** Typed GET-only capability. readToken is a local protected-entry/Keychain
 * callback; it is never populated from a relay job or stored on OpenChat.
 * @param {{readToken:()=>Promise<string>,port?:number,fetchImpl?:typeof fetch,timeoutMs?:number}} options
 */
export function createBeeperReadonlyClient({readToken,port=23373,fetchImpl=fetch,timeoutMs=10000}){
  if(typeof readToken!=='function'||!Number.isInteger(port)||port<1024||port>65535||!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>30000)bad();
  const origin=`http://127.0.0.1:${port}`;
  async function get(path,query={},beforeFetch){
    const token=await readToken();
    if(typeof token!=='string'||!token||/[\r\n]/u.test(token))throw new BeeperApiError('authorization_required');
    const url=new URL(path,origin);
    for(const [key,value] of Object.entries(query))if(value!==undefined)url.searchParams.set(key,identifier(value));
    let response;
    const start=()=>fetchImpl(url,{method:'GET',headers:{Authorization:`Bearer ${token}`,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
    try{response=await (beforeFetch?beforeFetch(start):start());}
    catch(error){if(error?.code==='local_approval_required')throw error;throw new BeeperApiError('unavailable');}
    if(response.status===401||response.status===403)throw new BeeperApiError('authorization_required');
    if(!response.ok)throw new BeeperApiError('unavailable');
    if(!response.headers.get('content-type')?.includes('application/json'))bad();
    const reader=response.body?.getReader();if(!reader)bad();
    const chunks=[];let size=0;
    try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>4*1024*1024){await reader.cancel();bad();}chunks.push(value);}}
    catch(error){if(error instanceof BeeperApiError)throw error;throw new BeeperApiError('unavailable');}
    try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{bad();}
  }
  return Object.freeze({
    info:()=>get('/v1/info'),
    accounts:async()=>{const value=await get('/v1/accounts');if(!Array.isArray(value))bad();return value;},
    /** @returns {Promise<Page>} */
    chats:async(accountId,{cursor,direction='before',beforeFetch}={})=>{
      if(!['before','after'].includes(direction))bad();
      const value=page(await get('/v1/chats',{accountIDs:identifier(accountId),cursor,direction},beforeFetch));
      // Server filtering is not an authority boundary: the Mac checks every row.
      if(value.items.some(chat=>chat.accountID!==accountId))bad();return value;
    },
    /** @returns {Promise<Record<string,unknown>>} */
    chat:async(accountId,chatId)=>{
      const value=await get(`/v1/chats/${encodeURIComponent(identifier(chatId))}`);
      if(value?.id!==chatId||value?.accountID!==accountId)bad();return value;
    },
    /** @returns {Promise<Page>} */
    messages:async(accountId,chatId,{cursor,direction='before',beforeFetch}={})=>{
      if(!['before','after'].includes(direction))bad();
      const value=page(await get(`/v1/chats/${encodeURIComponent(identifier(chatId))}/messages`,{cursor,direction},beforeFetch));
      if(value.items.some(message=>message.accountID!==accountId||message.chatID!==chatId))bad();return value;
    },
  });
}

/** Catalogue excludes source IDs, previews, participants, avatars, unread flags
 * and asset URLs before anything leaves the Mac. @param {Record<string,any>} chat
 */
export function catalogueEntry(chat,{identityKey,accountId,capturedAt}){
  if(chat.accountID!==accountId||String(chat.network).toLowerCase()!=='whatsapp')bad();
  if(!['group','single','direct'].includes(chat.type))bad();
  const readAt=date(capturedAt);if(!readAt)bad();
  return {accountKey:opaqueBeeperKey(identityKey,'account',identifier(accountId)),
    chatKey:opaqueBeeperKey(identityKey,'chat',accountId,identifier(chat.id)),network:'whatsapp',
    title:text(chat.title,200,true),chatType:chat.type==='group'?'group':'direct',
    lastActivityAt:date(chat.lastActivity),capturedAt:readAt};
}

/** One bounded v1 import batch, using only source attribution/timestamps.
 * No asks or private Memory are generated, and absence never means deletion.
 * @param {Record<string,any>} chat @param {Page} input
 */
export function importBatch(chat,input,{identityKey,accountId,capturedAt,selfUserId}){
  const catalogue=catalogueEntry(chat,{identityKey,accountId,capturedAt});page(input);
  if(input.items.length>100)bad();
  const participantMap=new Map(),messages=[];let unsupported=0;
  for(const m of input.items){
    if(m.accountID!==accountId||m.chatID!==chat.id)bad();
    // Unsupported control/reaction events are counted, never recast as text.
    if(m.isHidden===true||m.type==='REACTION'||m.type==='NOTICE'){unsupported++;continue;}
    const sentAt=date(m.timestamp),senderId=identifier(m.senderID);if(!sentAt)bad();
    const senderKey=opaqueBeeperKey(identityKey,'participant',accountId,chat.id,senderId);
    participantMap.set(senderKey,{sourceKey:senderKey,displayName:text(m.senderName,120),nameSource:'unknown',
      nameSourceMessageIds:[],membership:'unknown',...(selfUserId?{isOwner:senderId===selfUserId}:{}),profileFacts:[]});
    const hasMedia=Array.isArray(m.attachments)&&m.attachments.length>0;
    const editedAt=m.editedTimestamp===undefined?null:date(m.editedTimestamp);if(m.editedTimestamp!==undefined&&!editedAt)bad();
    messages.push({sourceMessageId:opaqueBeeperKey(identityKey,'message',accountId,chat.id,identifier(m.id)),senderKey,sentAt,
      kind:m.isDeleted===true?'deleted':hasMedia?'media':'text',text:m.isDeleted===true?null:text(m.text,20000),
      mediaType:m.isDeleted===true?null:hasMedia?'attachment':null,editedAt,replyToSourceMessageId:null});
  }
  const times=messages.map(m=>m.sentAt).sort();
  const payload={schemaVersion:1,source:{network:'whatsapp',accountKey:catalogue.accountKey,chatKey:catalogue.chatKey,chatType:catalogue.chatType,title:catalogue.title},
    coverage:{asOf:catalogue.capturedAt,method:'beeper-desktop-api-readonly',earliestMessageAt:times[0]??null,latestMessageAt:times.at(-1)??null,complete:false,
      note:`Partial Beeper API page; ${unsupported} unsupported control events omitted. Network history completeness is unknown.`},
    participants:[...participantMap.values()],messages,asks:[]};
  if(Buffer.byteLength(JSON.stringify(payload),'utf8')>1024*1024)bad();
  return {payload,hasMore:input.hasMore,newestCursor:input.newestCursor??null,oldestCursor:input.oldestCursor??null,unsupported};
}
