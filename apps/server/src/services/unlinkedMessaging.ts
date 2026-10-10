/* eslint-disable no-control-regex -- Reject controls in external profile IDs and OIDC subjects. */
import { nanoid } from 'nanoid';
import type { ManagedTransaction } from 'neo4j-driver';
import { getDriver } from '../db.js';
import { normalizePublicDisplayName } from '../privacy/profilePrivacy.js';

const ISSUER = 'https://id.ideaflow.app/api/auth';
const RESOLVER = 'https://www.unlinked.ai/api/messaging/v1/recipient';

export function unlinkedProfileId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^https:\/\/www\.unlinked\.ai\/people\/([A-Za-z0-9._~%-]{1,480})\/?$/.exec(value);
  if (!match) return null;
  try {
    const id = decodeURIComponent(match[1]);
    return id && id.length <= 160 && !['.', '..'].includes(id) && !/[\s/\\?#\x00-\x1f\x7f]/.test(id) ? id : null;
  } catch { return null; }
}

export type UnlinkedRecipient = { status: 'ready'; recipient: { id: string; name: string } }
  | { status: 'unclaimed'; name: string } | { status: 'unavailable' };

export async function resolveUnlinkedRecipient(profileId: string): Promise<UnlinkedRecipient> {
  const secret = process.env.UNLINKED_MESSAGING_SECRET;
  if (!secret || secret.length < 32) throw new Error('messaging_unavailable');
  const response = await fetch(RESOLVER, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` }, body: JSON.stringify({ profileId }) });
  if (!response.ok) throw new Error('messaging_unavailable');
  const text = await response.text();
  if (text.length > 4096) throw new Error('messaging_unavailable');
  const value = JSON.parse(text);
  if (value?.status === 'unavailable') return { status: 'unavailable' };
  const name = normalizePublicDisplayName(value?.name).slice(0, 160);
  if (value?.status === 'unclaimed') return { status: 'unclaimed', name };
  const identity = value?.identity;
  if (value?.status !== 'member' || identity?.issuer !== ISSUER || typeof identity.subject !== 'string' ||
      !identity.subject || identity.subject.length > 512 || /[\x00-\x1f\x7f]/.test(identity.subject)) throw new Error('messaging_unavailable');
  const recipient = await ensureSharedInbox(identity, name);
  return { status: 'ready', recipient };
}

export async function ensureSharedInbox(identity: { issuer: string; subject: string }, name: string): Promise<{ id: string; name: string }> {
  if (identity?.issuer !== ISSUER || typeof identity.subject !== 'string' || !identity.subject || identity.subject.length > 512 || /[\x00-\x1f\x7f]/.test(identity.subject)) throw new Error('invalid_identity');
  const session = getDriver().session();
  try { return await ensureSharedInboxInTransaction(session, identity, name); }
  finally { await session.close(); }
}

export async function ensureSharedInboxInTransaction(tx: Pick<ManagedTransaction, 'run'>, identity: { issuer: string; subject: string }, name: string): Promise<{ id: string; name: string }> {
  if (identity.issuer !== ISSUER || !identity.subject || identity.subject.length > 512 || /[\x00-\x1f\x7f]/.test(identity.subject)) throw new Error('invalid_identity');
    // Lazily materialize the same shared account. This is an inbox, not a
    // login, public profile, contact request, conversation or message.
    // The unique identity key also used at OIDC sign-in makes retries converge.
    const result = await tx.run(`MERGE (u:User {ideaflowIdentityKey:$key})
      ON CREATE SET u.id=$id,u.ideaflowIssuer=$issuer,u.ideaflowSub=$subject,
        u.name=$name,u.signupProvider='ideaflow-id',u.sharedInboxPending=true,
        u.createdAt=datetime(),u.presenceStatus='offline'
      WITH u WHERE u.ideaflowIssuer=$issuer AND u.ideaflowSub=$subject
      RETURN u.id AS id,u.name AS name`, { key: `${ISSUER}\u001f${identity.subject}`, id: nanoid(), issuer: ISSUER, subject: identity.subject, name });
    if (result.records.length !== 1 || typeof result.records[0].get('id') !== 'string') throw new Error('messaging_unavailable');
    return { id: result.records[0].get('id'), name: normalizePublicDisplayName(result.records[0].get('name')) };
}
