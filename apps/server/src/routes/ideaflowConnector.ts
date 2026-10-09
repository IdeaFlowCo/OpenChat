import { Router, type Request, type Response, type NextFunction } from 'express';
import { getDriver } from '../db.js';
import { verifyConnectorAssertion, issueConnectorOperation, consumeConnectorOperation, revokeConnectorOperation } from '../lib/ideaflowConnector.js';

const router = Router();
type Operation = { method: string; path: string; body?: unknown };
type Argument = { type: 'string' | 'integer' | 'boolean' | ['integer','null']; description?: string; minLength?: number; maxLength?: number; minimum?: number; maximum?: number; enum?: string[] };
type Tool = { name: string; description: string; scope: 'openchat:read' | 'openchat:write'; inputSchema: { type:'object'; properties:Record<string,Argument>; required:string[]; additionalProperties:false }; operation:(args:Record<string,any>)=>Operation };
const id: Argument = {type:'string',minLength:1,maxLength:200};
const text: Argument = {type:'string',minLength:1,maxLength:20000};
const limit: Argument = {type:'integer',minimum:1,maximum:100};
const encode = (value:string) => encodeURIComponent(value);
const context = (args:Record<string,any>) => `/api/chat/conversations/${encode(args.conversationId)}/context`;
const schema = (properties:Record<string,Argument>,required:string[]=[]) => ({type:'object' as const,properties,required,additionalProperties:false as const});
const query = (path:string,args:Record<string,any>) => {
  const params = new URLSearchParams(Object.entries(args).filter(([,v])=>v!==undefined).map(([k,v])=>[k,String(v)]));
  return params.size ? `${path}?${params}` : path;
};
// The owner's private people knowledge: the Noos people overlay. OpenChat shows it today; the Unlinked view is coming.
const PRIVATE = "Private people knowledge: visible only to the owner (never to the person it is about), stored in the owner's Ideaflow people overlay and shown in OpenChat (an Unlinked view is coming). Never notifies anyone, sends a connection request or changes a public profile.";
const PROVENANCE = "Notes and relations carry author ('owner' or 'agent:<client>'), source ('app', 'connector', 'direct-key' or 'suggestion') and assertion ('stated' or 'inferred'); these are null on records made before provenance was kept. Relations also carry relationType.";
const RELATION_TYPES = ['knows','family','works_at','worked_with','works_on','attended','interested_in','other'];
const assertion: Argument = {type:'string',enum:['stated','inferred'],description:"'stated' (default) when the user said it; 'inferred' when you concluded it yourself"};
const subjectPath = (kind:string,subjectId:string) => `/api/private/${kind==='user'?'people':kind==='unlinked'?'unlinked-people':'things'}/${encode(subjectId)}`;
const subjectKind: Argument = {type:'string',enum:['user','thing','unlinked'],description:"'user' = an OpenChat person (user id); 'thing' = one of the owner's saved people, companies, ideas or projects (its id); 'unlinked' = an Unlinked profile (profile id from an unlinked__ tool result)"};
const tools:Tool[] = [
  {name:'oc_list_conversations',description:'List conversations belonging to the linked OpenChat account.',scope:'openchat:read',inputSchema:schema({}),operation:()=>({method:'GET',path:'/api/chat/conversations'})},
  {name:'oc_get_messages',description:'Read messages in a conversation where the linked account is a participant.',scope:'openchat:read',inputSchema:schema({conversationId:id,limit,before:{type:'string',maxLength:200}},['conversationId']),operation:a=>({method:'GET',path:query(`/api/chat/conversations/${encode(a.conversationId)}/messages`,{limit:a.limit,before:a.before})})},
  {name:'oc_search',description:'Search messages, conversations and discoverable people; message access remains restricted to conversation membership.',scope:'openchat:read',inputSchema:schema({q:{type:'string',minLength:2,maxLength:200},conversationId:id,limit},['q']),operation:a=>({method:'GET',path:query('/api/chat/search',{q:a.q,conversationId:a.conversationId,scope:a.conversationId?'conversation':'global',limit:a.limit})})},
  {name:'oc_list_conversation_content',description:'Read shared Context posts and shared Stream entries in one audience-labeled feed. Private Stream entries are excluded for agents. Cursor is bound to the exact conversation and query.',scope:'openchat:read',inputSchema:schema({conversationId:id,limit,cursor:{type:'string',maxLength:2000},search:{type:'string',maxLength:200},filter:{type:'string',enum:['all','context','stream']}},['conversationId']),operation:a=>({method:'GET',path:query(`/api/chat/conversations/${encode(a.conversationId)}/content`,{limit:a.limit,cursor:a.cursor,search:a.search,filter:a.filter})})},
  {name:'oc_list_context_posts',description:'Read quiet Context posts, replies and author attribution. Search is case insensitive; cursor is opaque.',scope:'openchat:read',inputSchema:schema({conversationId:id,limit,cursor:{type:'string',maxLength:2000},search:{type:'string',maxLength:200},kind:{type:'string',enum:['note','ask','offer']}},['conversationId']),operation:a=>({method:'GET',path:query(context(a),{limit:a.limit,cursor:a.cursor,search:a.search,kind:a.kind})})},
  {name:'oc_send_message',description:'Send a normal chat message, notifying participants according to their preferences. Use only when the user requested sending to this conversation. Reuse clientRequestId on retry.',scope:'openchat:write',inputSchema:schema({conversationId:id,content:text,clientRequestId:id,replyToId:id},['conversationId','content','clientRequestId']),operation:a=>({method:'POST',path:`/api/chat/conversations/${encode(a.conversationId)}/messages`,body:{content:a.content,clientRequestId:a.clientRequestId,...(a.replyToId?{replyToId:a.replyToId}:{})}})},
  {name:'oc_create_context_post',description:'Publish shared quiet Context text or a threaded reply; no human notification. Never disclose private information without owner approval.',scope:'openchat:write',inputSchema:schema({conversationId:id,text,clientRequestId:id,replyToId:id,kind:{type:'string',enum:['note','ask','offer']}},['conversationId','text','clientRequestId']),operation:a=>({method:'POST',path:context(a),body:{text:a.text,clientRequestId:a.clientRequestId,...(a.replyToId?{replyToId:a.replyToId}:{}),...(a.kind?{kind:a.kind}:{})}})},
  {name:'oc_update_context_post',description:'Edit your own Context post using its current revision. Stale revisions are rejected.',scope:'openchat:write',inputSchema:schema({conversationId:id,postId:id,text,expectedRevision:{type:'integer',minimum:1}},['conversationId','postId','text','expectedRevision']),operation:a=>({method:'PATCH',path:`${context(a)}/${encode(a.postId)}`,body:{text:a.text,expectedRevision:a.expectedRevision}})},
  {name:'oc_delete_context_post',description:'Delete a Context post you authored or may moderate as group owner. Removes text and retains a thread tombstone.',scope:'openchat:write',inputSchema:schema({conversationId:id,postId:id},['conversationId','postId']),operation:a=>({method:'DELETE',path:`${context(a)}/${encode(a.postId)}`})},
  {name:'oc_get_person_private',description:`Read the owner's private card about an OpenChat person: importance, catch-up cadence, private notes and private relations to other people, companies, ideas and projects. ${PROVENANCE} ${PRIVATE}`,scope:'openchat:read',inputSchema:schema({userId:id},['userId']),operation:a=>({method:'GET',path:`/api/private/people/${encode(a.userId)}`})},
  {name:'oc_get_unlinked_person_private',description:`Read the owner's private card about an Unlinked profile (profile id from an unlinked__ tool result): notes and relations recorded about that person. Empty when nothing is recorded yet. ${PRIVATE}`,scope:'openchat:read',inputSchema:schema({profileId:{type:'string',minLength:1,maxLength:160}},['profileId']),operation:a=>({method:'GET',path:`/api/private/unlinked-people/${encode(a.profileId)}`})},
  {name:'oc_list_private_links',description:`List every private relation the owner has recorded ("knows", "sister of", "worked with"…), newest first, optionally filtered by a name or relation. Each end says whether it is an OpenChat person (user id), an Unlinked profile (unlinkedProfileId) or a saved thing (id). ${PROVENANCE} ${PRIVATE}`,scope:'openchat:read',inputSchema:schema({query:{type:'string',maxLength:120}}),operation:a=>({method:'GET',path:query('/api/private/links',{q:a.query})})},
  {name:'oc_search_private',description:`Search the owner's private people knowledge in one call: saved people, companies, ideas and projects, plus OpenChat people and Unlinked people the owner has written about, matched by name or private note text; and private relations matched by relation text, either end's name, or relationType (${RELATION_TYPES.join(', ')}). Give at least one of query, relationType or kind. Results are bounded; truncated says more matched. ${PROVENANCE} ${PRIVATE}`,scope:'openchat:read',inputSchema:schema({query:{type:'string',maxLength:120},relationType:{type:'string',enum:RELATION_TYPES},kind:{type:'string',enum:['person','company','idea','project']},limit:{type:'integer',minimum:1,maximum:50}}),operation:a=>({method:'GET',path:query('/api/private/search',{q:a.query,relationType:a.relationType,kind:a.kind,limit:a.limit})})},
  {name:'oc_get_neighbourhood',description:`Read one person or thing and what surrounds it in the owner's private graph: everything one (default) or two private relations away, and those relations with their ends (fromId/toId). Subject: subjectKind user (OpenChat user id), thing (saved thing id) or unlinked (Unlinked profile id). Never creates anything; empty when nothing is recorded. Bounded; truncated says it was cut. ${PROVENANCE} ${PRIVATE}`,scope:'openchat:read',inputSchema:schema({subjectKind,subjectId:id,depth:{type:'integer',minimum:1,maximum:2}},['subjectKind','subjectId']),operation:a=>({method:'GET',path:query('/api/private/neighbourhood',{subjectKind:a.subjectKind,subjectId:a.subjectId,depth:a.depth})})},
  {name:'oc_list_private_things',description:`List the owner's saved people, companies, ideas and projects (not OpenChat accounts), optionally by name and kind. Use an id with oc_get_private_thing. ${PRIVATE}`,scope:'openchat:read',inputSchema:schema({query:{type:'string',maxLength:120},kind:{type:'string',enum:['person','company','idea','project']}}),operation:a=>({method:'GET',path:query('/api/private/things',{q:a.query,kind:a.kind})})},
  {name:'oc_get_private_thing',description:`Read one saved person, company, idea or project with its private notes and relations. ${PROVENANCE} ${PRIVATE}`,scope:'openchat:read',inputSchema:schema({thingId:{type:'string',minLength:1,maxLength:64}},['thingId']),operation:a=>({method:'GET',path:`/api/private/things/${encode(a.thingId)}`})},
  {name:'oc_list_catch_up',description:`List OpenChat people whose private catch-up date has passed, soonest first. ${PRIVATE}`,scope:'openchat:read',inputSchema:schema({}),operation:()=>({method:'GET',path:'/api/private/due'})},
  {name:'oc_set_person_private',description:`Set the owner's private importance or catch-up cadence for an OpenChat person. cadenceDays null clears it; cadenceMode expanding stretches the gap after each catch-up; contactedNow true records a catch-up today. ${PRIVATE}`,scope:'openchat:write',inputSchema:schema({userId:id,important:{type:'boolean'},cadenceDays:{type:['integer','null'],minimum:1,maximum:3650},cadenceMode:{type:'string',enum:['fixed','expanding']},contactedNow:{type:'boolean'}},['userId']),operation:({userId,...patch})=>({method:'PATCH',path:`/api/private/people/${encode(userId)}`,body:patch})},
  {name:'oc_add_private_note',description:`Add a private note about an OpenChat person, a saved thing or an Unlinked profile. Adding the same text again returns the existing note. The note is recorded as written by this agent. ${PRIVATE}`,scope:'openchat:write',inputSchema:schema({subjectKind,subjectId:id,text:{type:'string',minLength:1,maxLength:4000},assertion},['subjectKind','subjectId','text']),operation:a=>({method:'POST',path:`${subjectPath(a.subjectKind,a.subjectId)}/notes`,body:{text:a.text,...(a.assertion!==undefined?{assertion:a.assertion}:{})}})},
  {name:'oc_delete_private_note',description:`Delete (undo) one of the owner's private notes by id. ${PRIVATE}`,scope:'openchat:write',inputSchema:schema({noteId:{type:'string',minLength:1,maxLength:64}},['noteId']),operation:a=>({method:'DELETE',path:`/api/private/notes/${encode(a.noteId)}`})},
  {name:'oc_add_private_link',description:`Record a private relation in the owner's own words ("knows", "sister of", "worked with", "works at") from a person or thing to another. Target: toKind user + toId (OpenChat user id), toKind unlinked + toId (Unlinked profile id from an unlinked__ tool result), or toKind person/company/idea/project with toId (saved thing) or toName. A name is reused only when it names exactly one saved thing; when several people share it the call fails with code ambiguous_name and candidates — ask the user which one, then pass its toKind/toId. Set createNew true with a clientRequestId only to save a different person with an existing name. The same subject, relation and target is one link, so retries never duplicate. The relation is recorded as written by this agent, with a relationType derived from its words. ${PRIVATE}`,scope:'openchat:write',inputSchema:schema({subjectKind,subjectId:id,relation:{type:'string',minLength:1,maxLength:60},toKind:{type:'string',enum:['user','unlinked','person','company','idea','project']},toId:id,toName:{type:'string',minLength:1,maxLength:120},createNew:{type:'boolean'},clientRequestId:id,assertion},['subjectKind','subjectId','relation','toKind']),operation:a=>({method:'POST',path:`${subjectPath(a.subjectKind,a.subjectId)}/links`,body:{relation:a.relation,...(a.assertion!==undefined?{assertion:a.assertion}:{}),to:{kind:a.toKind,...(a.toId!==undefined?{id:a.toId}:{}),...(a.toName!==undefined?{name:a.toName}:{}),...(a.createNew!==undefined?{createNew:a.createNew}:{}),...(a.clientRequestId!==undefined?{clientRequestId:a.clientRequestId}:{})}}})},
  {name:'oc_save_private_thing',description:`Find or save a private person, company, idea or project by name, for someone with no OpenChat account or Unlinked profile ("remember Maya from dinner"). Returns its id for notes and links. A name is reused only when it names exactly one saved thing; when several share it the call fails with code ambiguous_name and candidates — ask the user which one. Set createNew true with a clientRequestId only to save a different one with an existing name; retries return the same entity. ${PRIVATE}`,scope:'openchat:write',inputSchema:schema({kind:{type:'string',enum:['person','company','idea','project']},name:{type:'string',minLength:1,maxLength:120},createNew:{type:'boolean'},clientRequestId:id},['kind','name']),operation:a=>({method:'POST',path:'/api/private/things/resolve',body:{kind:a.kind,name:a.name,...(a.createNew!==undefined?{createNew:a.createNew}:{}),...(a.clientRequestId!==undefined?{clientRequestId:a.clientRequestId}:{})}})},
  {name:'oc_delete_private_thing',description:`Delete (undo) one of the owner's saved people, companies, ideas or projects by id: removes the saved thing together with its private notes and every private relation to or from it. This is the undo for oc_save_private_thing and cannot be reversed. OpenChat people (user ids) are not saved things; remove their notes and relations one by one. ${PRIVATE}`,scope:'openchat:write',inputSchema:schema({thingId:{type:'string',minLength:1,maxLength:64}},['thingId']),operation:a=>({method:'DELETE',path:`/api/private/things/${encode(a.thingId)}`})},
  {name:'oc_update_private_link',description:`Correct one of the owner's private relations in place by link id, for example "sister of" to "cousin of". The relation text, its relationType and the link's identity change together; if the owner already has that exact relation between the same two ends, the two become one and the existing link is returned with merged true. Use oc_delete_private_link to remove a relation instead. ${PRIVATE}`,scope:'openchat:write',inputSchema:schema({linkId:{type:'string',minLength:1,maxLength:64},relation:{type:'string',minLength:1,maxLength:60},assertion},['linkId','relation']),operation:a=>({method:'PATCH',path:`/api/private/links/${encode(a.linkId)}`,body:{relation:a.relation,...(a.assertion!==undefined?{assertion:a.assertion}:{})}})},
  {name:'oc_delete_private_link',description:`Delete (undo) one of the owner's private relations by link id. ${PRIVATE}`,scope:'openchat:write',inputSchema:schema({linkId:{type:'string',minLength:1,maxLength:64}},['linkId']),operation:a=>({method:'DELETE',path:`/api/private/links/${encode(a.linkId)}`})},
  {name:'oc_ask_context_agents',description:'Explicitly queue a shared post for opted-in participant agents. Bounded pull inbox; no human notification or automatic execution.',scope:'openchat:write',inputSchema:schema({conversationId:id,postId:id},['conversationId','postId']),operation:a=>({method:'POST',path:`${context(a)}/${encode(a.postId)}/ask-agents`,body:{}})},
];

const DESTRUCTIVE=new Set(['oc_delete_context_post','oc_delete_private_note','oc_delete_private_link','oc_delete_private_thing']);

function validArguments(tool:Tool,args:unknown):args is Record<string,any> {
  if (!args || typeof args!=='object' || Array.isArray(args)) return false;
  const values=args as Record<string,unknown>;
  if (Object.keys(values).some(k=>!Object.hasOwn(tool.inputSchema.properties,k)) || tool.inputSchema.required.some(k=>values[k]===undefined)) return false;
  return Object.entries(values).every(([key,value])=>{
    const spec=tool.inputSchema.properties[key];
    if (spec.type==='boolean') return typeof value==='boolean';
    if (Array.isArray(spec.type) && value===null) return true;
    if (spec.type==='integer' || Array.isArray(spec.type)) return Number.isSafeInteger(value) && (spec.minimum===undefined || (value as number)>=spec.minimum) && (spec.maximum===undefined || (value as number)<=spec.maximum);
    return typeof value==='string' && (!spec.minLength || value.trim().length>=spec.minLength) && (!spec.maxLength || value.length<=spec.maxLength) && (!spec.enum || spec.enum.includes(value));
  });
}

/** This guard is the sole creator of trusted REST request principals. */
export function connectorOperationGuard(req:Request,res:Response,next:NextFunction):void {
  const token=req.headers.authorization?.replace(/^Bearer /,'');
  if (!token?.startsWith('ifop_')) { next(); return; }
  if (!consumeConnectorOperation(token,req)) {res.status(401).json({error:'Invalid connector operation'});return;}
  next();
}

export async function handleIdeaflowConnector(req:Request,res:Response):Promise<void> {
  res.setHeader('Cache-Control','no-store');
  let rpcId:unknown=null;
  const fail=(status:number,code:number,message:string)=>res.status(status).json({jsonrpc:'2.0',id:rpcId,error:{code,message}});
  const secret=process.env.IDEAFLOW_CONNECTOR_SECRET || '';
  if(Buffer.byteLength(secret)<32){fail(503,-32001,'Unified connector is not configured');return;}
  if(!Buffer.isBuffer(req.body)){fail(400,-32600,'JSON request body required');return;}
  const identity=verifyConnectorAssertion(req.headers.authorization?.replace(/^Bearer /,'') || '',req.body,secret);
  if(!identity){fail(401,-32001,'Invalid connector assertion');return;}
  let body:any;
  try {body=JSON.parse(req.body.toString('utf8'));}catch {fail(400,-32700,'Invalid JSON');return;}
  if (!body || typeof body!=='object' || Array.isArray(body) || body.jsonrpc!=='2.0' || typeof body.method!=='string') {fail(400,-32600,'Invalid JSON-RPC request');return;}
  if(body.id!==undefined && body.id!==null && typeof body.id!=='string' && typeof body.id!=='number'){fail(400,-32600,'Invalid request ID');return;}
  rpcId=body.id??null;
  const session=getDriver().session();
  let userId:string;
  try {
    const result=await session.run(`MATCH (u:User {ideaflowIssuer:$issuer, ideaflowSub:$subject}) RETURN u.id AS id LIMIT 2`,{issuer:identity.identity_issuer,subject:identity.sub});
    if(result.records.length!==1 || typeof result.records[0].get('id')!=='string'){fail(409,-32001,'account_link_required');return;}
    userId=result.records[0].get('id');
  }catch {fail(503,-32001,'OpenChat account lookup is temporarily unavailable');return;}finally{await session.close();}
  const scopes=identity.scope.split(' ');
  const result=(value:unknown)=>res.json({jsonrpc:'2.0',id:rpcId,result:value});
  if(body.method==='initialize'){result({protocolVersion:'2025-03-26',capabilities:{tools:{listChanged:false}},serverInfo:{name:'OpenChat',version:'1.0.0'}});return;}
  if(body.method==='notifications/initialized'){res.status(202).end();return;}
  if(body.method==='ping'){result({});return;}
  if(body.method==='tools/list'){result({tools:tools.filter(t=>scopes.includes(t.scope)).map(({name,description,inputSchema,scope})=>({name,description,inputSchema,securitySchemes:[{type:'oauth2',scopes:[scope]}],annotations:{readOnlyHint:scope==='openchat:read',destructiveHint:DESTRUCTIVE.has(name),openWorldHint:false}}))});return;}
  if(body.method!=='tools/call'){fail(400,-32601,'Method not found');return;}
  const tool=tools.find(t=>t.name===body.params?.name);
  if(!tool){fail(400,-32602,'Unknown tool');return;}
  if(!scopes.includes(tool.scope)){fail(403,-32003,`Missing ${tool.scope} scope`);return;}
  const args=body.params?.arguments??{};
  if(!validArguments(tool,args)){fail(400,-32602,'Invalid tool arguments');return;}
  const operation=tool.operation(args);
  // The URL comes only from an allowlisted builder and the bound local listening port.
  // The caller cannot select a remote host or arbitrary REST endpoint.
  const token=issueConnectorOperation(userId,operation,scopes,identity.client);
  try {
    const response=await fetch(`http://127.0.0.1:${req.socket.localPort}${operation.path}`,{
      method:operation.method,headers:{Authorization:`Bearer ${token}`,...(operation.body!==undefined?{'Content-Type':'application/json'}:{})},
      ...(operation.body!==undefined?{body:JSON.stringify(operation.body)}:{}),signal:AbortSignal.timeout(20000),redirect:'error',
    });
    const responseText=await response.text();
    result({content:[{type:'text',text:responseText || (response.ok?'Completed':`OpenChat returned ${response.status}`)}],...(response.ok?{}:{isError:true})});
  }catch {fail(503,-32001,'OpenChat operation failed; retry writes with the same clientRequestId');}
  finally {revokeConnectorOperation(token);}
}
router.post('/mcp',handleIdeaflowConnector);
export default router;
