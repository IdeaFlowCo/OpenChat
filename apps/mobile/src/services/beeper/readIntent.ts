import * as Crypto from 'expo-crypto';
import type {BeeperReadConnection,BeeperReadJob,BeeperCatalogueEntry} from '../../api/client';

export interface LocalBeeperReadCapability {
  protocol:'openchat.beeper.read.v1';
  route:string;
  audience:'beeper.read';
  machineKey:string;
  deviceKey:string;
  accountKey:string;
  chatKey:string;
  grantId:string;
  expiresAt:number;
  /** The reviewed device registry owns keys and monotonically authorizes this
   * typed operation. It must never use a server-provided key or generic prompt. */
  sealRead(request:Readonly<Record<string,unknown>>):Promise<string>;
}
type Scope={route:string;audience:'beeper.read';machineKey:string;deviceKey:string;accountKey:string;chatKey:string};
type Resolver=(scope:Readonly<Scope>)=>Promise<LocalBeeperReadCapability|null>;
let resolveLocal:Resolver|undefined;

/** Extension point for the separately reviewed machine/device identity registry.
 * No resolver is installed by a server response or source installation. Actual
 * local enrollment and the typed Mac grant require the owner's own approval. */
export function installReviewedBeeperReadResolver(resolver:Resolver){
  resolveLocal=resolver;
  return ()=>{if(resolveLocal===resolver)resolveLocal=undefined;};
}
export class BeeperSecureGrantRequired extends Error {
  readonly code='beeper_secure_grant_required';
  constructor(){super('Approve this selected chat on your paired Mac before reading it here. Secure Beeper pairing must be enabled first.');}
}
export async function authorizeBeeperRead(connection:BeeperReadConnection,job:BeeperReadJob,chat:BeeperCatalogueEntry):Promise<string>{
  const resolver=resolveLocal;
  if(!resolver||connection.state!=='active'||Date.parse(connection.expiresAt)<=Date.now())throw new BeeperSecureGrantRequired();
  const scope:Scope={route:connection.id,audience:'beeper.read',machineKey:connection.machineKey,deviceKey:connection.deviceKey,accountKey:connection.accountKey,chatKey:chat.chatKey};
  const grant=await resolver(Object.freeze(scope));
  if(resolveLocal!==resolver||!grant||grant.protocol!=='openchat.beeper.read.v1'||grant.expiresAt<=Date.now()
    ||Object.entries(scope).some(([key,value])=>grant[key as keyof Scope]!==value))throw new BeeperSecureGrantRequired();
  if(!job.id||!Number.isSafeInteger(job.epoch)||job.epoch<1)throw new Error('Reload the selected chat request before approving it.');
  const requestId=Array.from(await Crypto.getRandomBytesAsync(16),b=>b.toString(16).padStart(2,'0')).join('');
  const frame=await grant.sealRead(Object.freeze({protocol:grant.protocol,...scope,destination:'https://chat.ideaflow.app',
    operation:'readSelected',connectionId:connection.id,grantId:grant.grantId,jobId:job.id,epoch:job.epoch,requestId,
    expiresAt:Math.min(grant.expiresAt,Date.now()+5*60000),kind:job.kind}));
  if(resolveLocal!==resolver||grant.expiresAt<=Date.now()||typeof frame!=='string'||frame.length<56||frame.length>48000||!/^[A-Za-z0-9+/]+={0,2}$/.test(frame))throw new BeeperSecureGrantRequired();
  return frame;
}
