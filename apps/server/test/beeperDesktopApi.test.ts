import {describe,expect,it,vi} from 'vitest';
import {createBeeperReadonlyClient,catalogueEntry,importBatch,opaqueBeeperKey} from '../../../scripts/beeper-client/desktopApi.mjs';
import {parseImportPayload} from '../src/services/importedChats.js';

const key=new Uint8Array(32).fill(17),accountId='synthetic-account',chatId='!synthetic-room:local';
const capturedAt='2026-11-26T22:00:00.000Z';
const chat={id:chatId,accountID:accountId,network:'WhatsApp',type:'group',title:'Synthetic chat',lastActivity:capturedAt,
  preview:{text:'Must never leave the catalogue'},participants:{items:[{phoneNumber:'private source metadata'}]},unreadCount:21,imgURL:'http://never-fetch.invalid/avatar'};
const message={id:'source-message',accountID:accountId,chatID:chatId,senderID:'synthetic-sender',senderName:'Synthetic Sender',timestamp:capturedAt,text:'Original #words',type:'TEXT'};
const opts={identityKey:key,accountId,capturedAt};
describe('Mac-local GET-only Beeper adapter',()=>{
  it('has a fixed loopback origin and exposes no send/read-state/focus primitive',async()=>{
    const transport=vi.fn(async()=>Response.json({items:[chat],hasMore:false}));
    const client=createBeeperReadonlyClient({readToken:async()=>'synthetic-token',fetchImpl:transport});
    await client.chats(accountId,{cursor:'opaque cursor?x=1',direction:'before'});
    const [url,request]=transport.mock.calls[0]!;
    expect(url.origin).toBe('http://127.0.0.1:23373');expect(url.pathname).toBe('/v1/chats');expect(url.searchParams.get('accountIDs')).toBe(accountId);
    expect(url.searchParams.get('cursor')).toBe('opaque cursor?x=1');expect(request.method).toBe('GET');expect(request.redirect).toBe('error');
    expect(Object.keys(client)).toEqual(['info','accounts','chats','chat','messages']);
    expect(JSON.stringify(client)).not.toContain('synthetic-token');
  });
  it('encodes source chat IDs and refuses account/chat mismatches before upload',async()=>{
    const transport=vi.fn(async()=>Response.json({items:[message],hasMore:false}));
    const client=createBeeperReadonlyClient({readToken:async()=>'synthetic-token',fetchImpl:transport});
    await client.messages(accountId,chatId);
    expect(transport.mock.calls[0]![0].pathname).toBe('/v1/chats/!synthetic-room%3Alocal/messages');
    await expect(client.messages('foreign-account',chatId)).rejects.toMatchObject({code:'incompatible'});
    await expect(client.messages(accountId,'foreign-chat')).rejects.toMatchObject({code:'incompatible'});
    await expect(client.messages(accountId,'..')).rejects.toMatchObject({code:'incompatible'});
  });
  it('fails closed on auth, redirects/network errors, incompatible and oversized responses without disclosing source bodies',async()=>{
    const client=(fetchImpl:typeof fetch)=>createBeeperReadonlyClient({readToken:async()=>'synthetic-token',fetchImpl});
    await expect(client(async()=>new Response('private error body',{status:401})).info()).rejects.toMatchObject({code:'authorization_required'});
    await expect(client(async()=>{throw new Error('private network diagnostic');}).info()).rejects.toMatchObject({code:'unavailable'});
    await expect(client(async()=>new Response('private html',{headers:{'content-type':'text/html'}})).info()).rejects.toMatchObject({code:'incompatible'});
    await expect(client(async()=>new Response('x'.repeat(4*1024*1024+1),{headers:{'content-type':'application/json'}})).info()).rejects.toMatchObject({code:'incompatible'});
  });
  it('drops preview/roster/phone/unread/avatar metadata and uses stable domain-separated opaque IDs',()=>{
    const entry=catalogueEntry(chat,opts),serialized=JSON.stringify(entry);
    expect(Object.keys(entry)).toEqual(['accountKey','chatKey','network','title','chatType','lastActivityAt','capturedAt']);
    for(const source of [accountId,chatId,'Must never','phoneNumber','unreadCount','imgURL'])expect(serialized).not.toContain(source);
    expect(entry.chatKey).toBe(catalogueEntry({...chat,title:'Renamed'},opts).chatKey);
    expect(opaqueBeeperKey(key,'chat',accountId,chatId)).not.toBe(opaqueBeeperKey(key,'message',accountId,chatId));
  });
  it('produces a valid bounded existing v1 import with edits/tombstones and no attachment fetching or history-complete claim',()=>{
    const batch=importBatch(chat,{hasMore:false,items:[message,{...message,id:'edited',editedTimestamp:'2026-11-26T22:01:00Z'},
      {...message,id:'deleted',isDeleted:true,text:'Deleted secret'},
      {...message,id:'media',text:undefined,attachments:[{srcURL:'http://never-fetch.invalid/source',mimeType:'image/jpeg'}]},
      {...message,id:'reaction',type:'REACTION'},{...message,id:'hidden',isHidden:true}]},opts);
    const parsed=parseImportPayload(batch.payload);
    expect(parsed.messages).toHaveLength(4);expect(parsed.coverage.complete).toBe(false);expect(parsed.asks).toEqual([]);
    expect(parsed.messages.find(m=>m.editedAt)?.editedAt).toBe('2026-11-26T22:01:00.000Z');
    expect(parsed.messages.find(m=>m.kind==='deleted')?.text).toBeNull();expect(batch.unsupported).toBe(2);
    expect(JSON.stringify(batch.payload)).not.toContain('never-fetch');expect(JSON.stringify(batch.payload)).not.toContain('Deleted secret');
    expect(parsed.participants[0]!.isOwner).toBeNull();
  });
  it('refuses over-limit source text, unsupported batches and unattributed tombstones instead of fabricating identity or truncating',()=>{
    expect(()=>importBatch(chat,{items:[{...message,text:'x'.repeat(20001)}],hasMore:false},opts)).toThrow();
    expect(()=>importBatch(chat,{items:Array(101).fill(message),hasMore:false},opts)).toThrow();
    expect(()=>importBatch(chat,{items:[{...message,isDeleted:true,senderID:undefined}],hasMore:false},opts)).toThrow();
    expect(()=>catalogueEntry({...chat,accountID:'foreign'},opts)).toThrow();
  });
});

it('maps only an explicitly selected network and refuses automatic merged routing',()=>{
 const imessage={...chat,network:'iMessage'};
 expect(()=>catalogueEntry(imessage,opts)).toThrow();
 expect(()=>catalogueEntry(chat,{...opts,network:'imessage'})).toThrow();
 expect(()=>catalogueEntry({...imessage,merge:{}},{...opts,network:'imessage'})).toThrow();
 const batch=importBatch(imessage,{items:[message],hasMore:false},{...opts,network:'imessage'});
 expect(parseImportPayload(batch.payload).source.network).toBe('imessage');
 expect(batch.payload.source.accountKey).toBe(catalogueEntry(chat,opts).accountKey);
});
