import { Router, type Request, type Response, type NextFunction } from 'express';
import { getDriver } from '../db.js';
import { verifyConnectorAssertion, issueConnectorOperation, consumeConnectorOperation, revokeConnectorOperation } from '../lib/ideaflowConnector.js';

const router = Router();
type Operation = { method: string; path: string; body?: unknown };
type Argument = { type: 'string' | 'integer'; minLength?: number; maxLength?: number; minimum?: number; maximum?: number; enum?: string[] };
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
  {name:'oc_ask_context_agents',description:'Explicitly queue a shared post for opted-in participant agents. Bounded pull inbox; no human notification or automatic execution.',scope:'openchat:write',inputSchema:schema({conversationId:id,postId:id},['conversationId','postId']),operation:a=>({method:'POST',path:`${context(a)}/${encode(a.postId)}/ask-agents`,body:{}})},
];

function validArguments(tool:Tool,args:unknown):args is Record<string,any> {
  if (!args || typeof args!=='object' || Array.isArray(args)) return false;
  const values=args as Record<string,unknown>;
  if (Object.keys(values).some(k=>!Object.hasOwn(tool.inputSchema.properties,k)) || tool.inputSchema.required.some(k=>values[k]===undefined)) return false;
  return Object.entries(values).every(([key,value])=>{
    const spec=tool.inputSchema.properties[key];
    if (spec.type==='integer') return Number.isSafeInteger(value) && (spec.minimum===undefined || (value as number)>=spec.minimum) && (spec.maximum===undefined || (value as number)<=spec.maximum);
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
  if(body.method==='tools/list'){result({tools:tools.filter(t=>scopes.includes(t.scope)).map(({name,description,inputSchema,scope})=>({name,description,inputSchema,securitySchemes:[{type:'oauth2',scopes:[scope]}],annotations:{readOnlyHint:scope==='openchat:read',destructiveHint:name==='oc_delete_context_post',openWorldHint:false}}))});return;}
  if(body.method!=='tools/call'){fail(400,-32601,'Method not found');return;}
  const tool=tools.find(t=>t.name===body.params?.name);
  if(!tool){fail(400,-32602,'Unknown tool');return;}
  if(!scopes.includes(tool.scope)){fail(403,-32003,`Missing ${tool.scope} scope`);return;}
  const args=body.params?.arguments??{};
  if(!validArguments(tool,args)){fail(400,-32602,'Invalid tool arguments');return;}
  const operation=tool.operation(args);
  // The URL comes only from an allowlisted builder and the bound local listening port.
  // The caller cannot select a remote host or arbitrary REST endpoint.
  const token=issueConnectorOperation(userId,operation,scopes);
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
