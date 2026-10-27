import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row={id:string;conversationId:string;senderId:string;createdAt:number;content:string;assistantScope?:string;replyToId?:string;deletedAt?:number};
const h=vi.hoisted(()=>({rows:[] as Row[],member:true,create:vi.fn(),readApp:vi.fn(),pause:undefined as undefined|(()=>Promise<void>)}));
vi.mock('@anthropic-ai/sdk',()=>({default:class {messages={create:h.create};}}));
vi.mock('../src/services/appSources.js',()=>({readApp:h.readApp,appBridgeConfigured:()=>true}));
vi.mock('../src/db.js',()=>({getDriver:()=>({session:()=>({close:async()=>{},run:async(query:string,p:Record<string,any>)=>{
  const result=(rows:Record<string,unknown>[])=>({records:rows.map(row=>({get:(key:string)=>row[key]??null}))});
  if(p.scopeConversationId)return result(h.member?[{type:'direct',participants:['owner','assistant']}]:[]);
  if(p.limit){
    await h.pause?.();
    const origin=h.rows.find(r=>r.id===p.messageId&&r.conversationId===p.conversationId&&r.senderId===p.userId&&!r.deletedAt);
    if(!h.member)return result([]);
    const bounded=query.includes('m.createdAt < origin.createdAt');
    if(bounded&&!origin)return result([]);
    return result(h.rows.filter(r=>r.conversationId===p.conversationId&&!r.deletedAt&&(!bounded||r.id===origin!.id||r.createdAt<origin!.createdAt)).sort((a,b)=>b.createdAt-a.createdAt).map(r=>({...r,senderName:'Owner'})));
  }
  if(p.messageId){
    const origin=h.rows.find(r=>r.id===p.messageId&&r.conversationId===p.conversationId&&r.senderId===p.userId&&!r.deletedAt);
    if(p.id){
      const parent=h.rows.find(r=>r.id===p.id&&r.conversationId===p.conversationId&&!r.deletedAt&&origin&&r.createdAt<origin.createdAt);
      return result(h.member&&parent?[{...parent,senderName:'Owner'}]:[]);
    }
    return result(h.member&&origin?[origin]:[]);
  }
  return result([]);
}})})}));
import { loadAssistantTurn, runAssistantTurn } from '../src/services/assistant.js';
const a:Row={id:'A',conversationId:'dm',senderId:'owner',createdAt:1,content:'Universal request',assistantScope:'universal'};
const b:Row={id:'B',conversationId:'dm',senderId:'owner',createdAt:2,content:'Isolated request search Vision notes',assistantScope:'conversation'};
beforeEach(()=>{
  h.rows=[{...a}];h.member=true;h.pause=undefined;h.create.mockReset();h.readApp.mockReset().mockResolvedValue({results:[]});
  vi.stubEnv('ANTHROPIC_API_KEY','synthetic-local-model');
});
afterEach(()=>{vi.unstubAllEnvs();});
describe('persisted originating message authority and bounded model input',()=>{
  it('delayed universal A cannot consume isolated B that arrives during context loading',async()=>{
    let release!:()=>void;
    let entered!:()=>void;
    const waiting=new Promise<void>(resolve=>{entered=resolve;});
    h.pause=()=>{entered();return new Promise<void>(resolve=>{release=resolve;});};
    const delayed=loadAssistantTurn('owner','dm','A');
    await waiting;h.rows.push({...b});release();
    const turn=await delayed;
    expect(turn?.scope.kind).toBe('universal');
    expect(turn?.messages).toEqual([{role:'user',content:'Owner: Universal request'}]);
    h.pause=undefined;
    h.create.mockResolvedValue({stop_reason:'end_turn',content:[{type:'text',text:'Synthetic answer'}]});
    await runAssistantTurn({userId:'owner',conversationId:'dm',messageId:'A'});
    expect(h.create.mock.calls[0][0].messages).toEqual(turn?.messages);
    expect(h.create.mock.calls[0][0].tools.map((t:any)=>t.name)).toContain('vision_read');
    h.create.mockClear();
    h.create.mockResolvedValueOnce({stop_reason:'tool_use',content:[{type:'tool_use',id:'crafted',name:'vision_read',input:{tool:'search'}}]}).mockResolvedValueOnce({stop_reason:'end_turn',content:[{type:'text',text:'Scoped answer'}]});
    await runAssistantTurn({userId:'owner',conversationId:'dm',messageId:'B'});
    expect(h.create.mock.calls[0][0].tools.map((t:any)=>t.name)).not.toContain('vision_read');
    expect(h.readApp).not.toHaveBeenCalled();
    expect(h.create.mock.calls[1][0].messages.at(-1).content[0].content).toContain("Not available in this chat's context");
  });
  it.each(['missing','foreign-chat','foreign-actor','deleted','revoked','invalid-scope'])('rejects %s origins before a model turn',async mode=>{
    if(mode==='foreign-chat')h.rows[0].conversationId='elsewhere';
    if(mode==='foreign-actor')h.rows[0].senderId='someone-else';
    if(mode==='deleted')h.rows[0].deletedAt=3;
    if(mode==='revoked')h.member=false;
    if(mode==='invalid-scope')h.rows[0].assistantScope='forged';
    await runAssistantTurn({userId:'owner',conversationId:'dm',messageId:mode==='missing'?'absent':'A'});
    expect(h.create).not.toHaveBeenCalled();
  });
  it('conservatively excludes later messages sharing the originating timestamp',async()=>{
    h.rows.push({...b,createdAt:a.createdAt});
    expect((await loadAssistantTurn('owner','dm','A'))?.messages).toEqual([{role:'user',content:'Owner: Universal request'}]);
  });
  it('keeps same-chat readable ancestry but hides foreign and deleted parents',async()=>{
    h.rows=[{...a,replyToId:'old'},{...a,id:'old',content:'Old source',createdAt:0}];
    expect((await loadAssistantTurn('owner','dm','A'))?.messages.at(-1)?.content).toContain('Replying to Owner: Old source');
    h.rows[1].conversationId='private';
    const foreign=(await loadAssistantTurn('owner','dm','A'))?.messages;
    expect(JSON.stringify(foreign)).not.toContain('Old source');
    expect(foreign?.at(-1)?.content).toContain('earlier message (unavailable)');
    h.rows[1].conversationId='dm';h.rows[1].deletedAt=3;
    expect(JSON.stringify((await loadAssistantTurn('owner','dm','A'))?.messages)).not.toContain('Old source');
  });
});
