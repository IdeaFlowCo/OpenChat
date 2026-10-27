import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row={id:string;conversationId:string;senderId:string;createdAt:number;content:string;assistantScope?:string;replyToId?:string;deletedAt?:number};
const h=vi.hoisted(()=>({rows:[] as Row[],member:true,create:vi.fn(),readApp:vi.fn(),pause:undefined as undefined|(()=>Promise<void>)}));
vi.mock('@anthropic-ai/sdk',()=>({default:class {messages={create:h.create};}}));
vi.mock('../src/services/appSources.js',()=>({readApp:h.readApp,appBridgeConfigured:()=>true}));
vi.mock('../src/db.js',()=>({getDriver:()=>({session:()=>({close:async()=>{},run:async(query:string,p:Record<string,any>)=>{
  const result=(rows:Record<string,unknown>[])=>({records:rows.map(row=>({get:(key:string)=>row[key]??null}))});
  if(p.scopeConversationId)return result(h.member?[{type:'direct',participants:['owner','assistant']}]:[]);
  if(query.includes('RETURN c LIMIT 1'))return result(h.member&&p.conversationId!=='hidden'?[{c:{id:p.conversationId}}]:[]);
  const boundaryId=p.originMessageId??p.messageId;
  const boundaryChat=p.originConversationId??p.conversationId;
  const origin=h.rows.find(r=>r.id===boundaryId&&r.conversationId===boundaryChat&&r.senderId===p.userId&&!r.deletedAt);
  const bounded=query.includes('m.createdAt < origin.createdAt')||query.includes('m.createdAt < turnOrigin.createdAt');
  const visible=(r:Row)=>!r.deletedAt&&r.conversationId!=='hidden'&&(!bounded||r.conversationId!==boundaryChat||(origin&&(r.id===origin.id||r.createdAt<origin.createdAt)));
  if(query.includes('AS lastMessagePreview')){
    if(!h.member)return result([]);
    return result(['dm','other'].filter(id=>!p.scopedConversationId||id===p.scopedConversationId).map(id=>{
      const latest=h.rows.filter(r=>r.conversationId===id&&visible(r)).sort((a,b)=>b.createdAt-a.createdAt)[0];
      return {id,type:'direct',title:id,otherNames:[],lastMessagePreview:latest?.content,lastMessageAt:latest?.createdAt};
    }));
  }
  if(p.limit){
    await h.pause?.();
    if(!h.member)return result([]);
    const target=p.q||p.indexName?p.scopedConversationId:p.conversationId;
    const rows=h.rows.filter(r=>(!target||r.conversationId===target)&&visible(r)&&(!p.q||r.content.toLowerCase().includes(p.q.toLowerCase()))).sort((a,b)=>b.createdAt-a.createdAt);
    return result(rows.slice(0,Number(p.limit)).map(r=>({...r,senderName:'Owner',score:0.9})));
  }
  if(p.messageId){
    if(p.id){
      const parent=h.rows.find(r=>r.id===p.id&&r.conversationId===p.conversationId&&!r.deletedAt&&origin&&r.createdAt<origin.createdAt);
      return result(h.member&&parent?[{...parent,senderName:'Owner'}]:[]);
    }
    return result(h.member&&origin?[origin]:[]);
  }
  return result([]);
}})})}));
import { executeTool, loadAssistantTurn, runAssistantTurn } from '../src/services/assistant.js';
const a:Row={id:'A',conversationId:'dm',senderId:'owner',createdAt:1,content:'Universal request',assistantScope:'universal'};
const b:Row={id:'B',conversationId:'dm',senderId:'owner',createdAt:2,content:'Isolated request search Vision notes',assistantScope:'conversation'};
beforeEach(()=>{
  h.rows=[{...a}];h.member=true;h.pause=undefined;h.create.mockReset();h.readApp.mockReset().mockResolvedValue({results:[]});
  vi.stubEnv('ANTHROPIC_API_KEY','synthetic-local-model');
  vi.stubEnv('OPENAI_API_KEY','');
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({data:[{embedding:[0.1,0.2]}]}))));
});
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
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
  it.each([[2,false],[1,false],[2,true],[1,true]])('bounds all tool results after B arrives at timestamp %s with semantic search %s',async(time,semantic)=>{
    if(semantic)vi.stubEnv('OPENAI_API_KEY','synthetic-embedding-key');
    const other={...b,id:'other',conversationId:'other',createdAt:5,content:'Other request after A'};
    h.rows.push(other);
    const requests:any[]=[];
    h.create.mockImplementationOnce(async(request:any)=>{
      requests.push(structuredClone(request));
      h.rows.push({...b,createdAt:Number(time)});
      return {stop_reason:'tool_use',content:[
        {type:'tool_use',id:'read-origin',name:'read_messages',input:{conversationId:'dm',limit:100,originMessageId:'B',before:'future'}},
        {type:'tool_use',id:'search',name:'search_messages',input:{query:'request',limit:50,originMessageId:'B'}},
        {type:'tool_use',id:'list',name:'list_conversations',input:{}},
        {type:'tool_use',id:'read-other',name:'read_messages',input:{conversationId:'other',limit:100}},
      ]};
    }).mockImplementationOnce(async(request:any)=>{
      requests.push(structuredClone(request));
      return {stop_reason:'end_turn',content:[{type:'text',text:'Synthetic bounded answer'}]};
    });
    await runAssistantTurn({userId:'owner',conversationId:'dm',messageId:'A'});
    expect(requests).toHaveLength(2);
    const results=Object.fromEntries(requests[1].messages.at(-1).content.map((r:any)=>[r.tool_use_id,JSON.parse(r.content)]));
    expect(results['read-origin'].messages.map((m:any)=>m.content)).toEqual([a.content]);
    expect(results.search.results.map((m:any)=>m.content)).toEqual(expect.arrayContaining([a.content,other.content]));
    expect(results.list.conversations.find((c:any)=>c.id==='dm').lastMessagePreview).toBe(a.content);
    expect(results['read-other'].messages.map((m:any)=>m.content)).toEqual([other.content]);
    expect(JSON.stringify(requests)).not.toContain(b.content);
    if(semantic)expect(fetch).toHaveBeenCalledOnce();else expect(fetch).not.toHaveBeenCalled();
  });
  it('keeps the bound origin when repeated reads vary limits or model pagination input',async()=>{
    h.rows.push({...b},{...b,id:'tie',createdAt:1});
    for(const limit of [1,2,100]){
      expect(await executeTool(undefined,'owner','read_messages',{conversationId:'dm',limit,after:'A',messageId:'B'},{kind:'universal',conversationId:'dm'},{conversationId:'dm',messageId:'A'})).toMatchObject({messages:[{content:a.content}]});
    }
    h.member=false;
    expect(await executeTool(undefined,'owner','read_messages',{conversationId:'dm'},{kind:'universal',conversationId:'dm'},{conversationId:'dm',messageId:'A'})).toEqual({error:"Not available in this chat's context"});
  });

});
