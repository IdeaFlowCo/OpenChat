/** Short-lived model continuity for reviews; authorization remains publicationApproval. */
import { isDeepStrictEqual } from 'node:util';
import { cleanAskText } from './overlay/contract.js';
interface Review { ownerId:string; conversationId:string; originMessageId:string; input:Record<string,unknown>; grant:string; preview:unknown; at:number; committed:boolean }
const reviews=new Map<string,Review>();
const TTL=10*60_000, MAX=1000;
const key=(ownerId:string,conversationId:string,askId:unknown)=>JSON.stringify([ownerId,conversationId,askId]);
function purge() { for (const [id,review] of reviews) if (Date.now()-review.at>=TTL) reviews.delete(id); }
function payload(input:Record<string,unknown>) {
  const {confirm:_confirm,approvalGrant:_grant,...rest}=input;
  const audience=rest.audience as {kind:unknown;targets?:Array<{kind:string;id:string}>};
  const targets=[...new Map((audience.targets??[]).map(target=>[`${target.kind}:${target.id}`,target])).values()].sort((a,b)=>`${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
  return {...rest,text:cleanAskText(rest.text),audience:{...audience,targets}};
}
export function rememberAskPublicationReview(ownerId:string,conversationId:string,originMessageId:string,input:Record<string,unknown>,grant:string,preview:unknown) {
  purge();
  reviews.delete(key(ownerId,conversationId,input.askId));
  reviews.set(key(ownerId,conversationId,input.askId),{ownerId,conversationId,originMessageId,input:payload(input),grant,preview,at:Date.now(),committed:false});
  const owned=[...reviews.entries()].filter(([,review])=>review.ownerId===ownerId&&review.conversationId===conversationId);
  for(const [id] of owned.slice(0,Math.max(0,owned.length-20)))reviews.delete(id);
  while(reviews.size>MAX) reviews.delete(reviews.keys().next().value!);
}
/** Compare trusted persisted message instants with the server review-ready boundary. */
function messageTime(value:unknown):number|null {
  if(value==null)return null;
  let instant:number;
  if(typeof value==='number')instant=value;
  else if(typeof value==='object'&&typeof (value as {toNumber?:unknown}).toNumber==='function')instant=(value as {toNumber:()=>number}).toNumber();
  else {
    const text=String(value);
    instant=/^\d{13}$/.test(text)?Number(text):/^\d{4}-\d{2}-\d{2}T/.test(text)?Date.parse(text):NaN;
  }
  return Number.isFinite(instant)?instant:null;
}
export function askPublicationReviewMatches(ownerId:string,conversationId:string,messageId:string,input:Record<string,unknown>,messageCreatedAt:unknown):boolean {
  purge(); const review=reviews.get(key(ownerId,conversationId,input.askId));
  const authorizedAt=messageTime(messageCreatedAt);
  if(!review||authorizedAt===null||authorizedAt<=review.at||review.originMessageId===messageId||review.grant!==input.approvalGrant)return false;
  try{return isDeepStrictEqual(review.input,payload(input));}catch{return false;}
}
export function completeAskPublicationReview(ownerId:string,conversationId:string,askId:unknown) { const review=reviews.get(key(ownerId,conversationId,askId));if(review)review.committed=true; }
export function clearAskPublicationReview(ownerId:string,conversationId:string,askId:unknown) {reviews.delete(key(ownerId,conversationId,askId));}
export function pendingAskPublicationContext(ownerId:string,conversationId:string,messageId:string,messageCreatedAt:unknown):string {
  purge(); const authorizedAt=messageTime(messageCreatedAt);
  if(authorizedAt===null)return '';
  const pending=[...reviews.values()].filter(review=>review.ownerId===ownerId&&review.conversationId===conversationId&&review.originMessageId!==messageId&&authorizedAt>review.at&&!review.committed);
  if(!pending.length)return '';
  return `\n\nPENDING ASK PUBLICATION REVIEWS: These exact previews were prepared on earlier user turns and have not been committed. Only publish a specific review when the current user explicitly approves it. A changed text/audience needs a fresh review. Do not conflate separate reviews. Do not show internal IDs or approval tokens to the user. On approval call publish_ask with the corresponding stored payload below. On decline do not publish. Do not re-ask unrelated pending questions.\n${JSON.stringify(pending.map(review=>({preview:review.preview,payload:{...review.input,confirm:true,approvalGrant:review.grant}})))}`;
}
