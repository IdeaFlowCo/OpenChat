import type { Session, ManagedTransaction } from 'neo4j-driver';
import { nanoid } from 'nanoid';
import { normalizePublicDisplayName } from '../privacy/profilePrivacy.js';

export interface GoogleIdentity {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
}

export class GoogleIdentityError extends Error {
  constructor(public readonly status: 400 | 409, message: string) {
    super(message);
  }
}

const conflict = () => new GoogleIdentityError(409,
  'This Google identity cannot sign in to the existing OpenChat account. Account recovery requires independent ownership verification.');

const userProjection = `u { .id, .email, .name, .presenceStatus, .statusMessage,
  profileStatus: CASE WHEN u.profileStatusText IS NOT NULL OR u.profileStatusEmoji IS NOT NULL
    THEN { text: u.profileStatusText, emoji: u.profileStatusEmoji, updatedAt: u.profileStatusUpdatedAt }
    ELSE null END, .avatarUrl, .isBot }`;

interface GoogleUser { id: string; email: string; name: string }

// Uniquely keyed, persistent lock nodes serialize Google provisioning across
// server processes without imposing a new uniqueness constraint on shared,
// potentially duplicated legacy User emails/subjects. See the rollout note.
async function lock(tx: ManagedTransaction, key: string) {
  await tx.run(`MERGE (lock:OpenChatGoogleAuthLock {key: $key})
    SET lock._locked = true REMOVE lock._locked`, { key });
}

/** Resolve a verified Google identity. Email and existing account sessions
 * never authorize linking an unbound legacy account. Recovery needs a
 * separately reviewed ownership proof; this resolver cannot accept a target ID.
 */
export async function resolveGoogleIdentity(
  session: Session,
  identity: GoogleIdentity,
  signupProvider: 'google' | 'google-ios',
): Promise<GoogleUser> {
  if (typeof identity.sub !== 'string' || !identity.sub.trim()) {
    throw new GoogleIdentityError(400, 'Google identity did not include a subject');
  }
  const email = typeof identity.email === 'string' ? identity.email.trim().toLowerCase() : null;
  const verifiedEmail = email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    && identity.email_verified === true;
  const params = {
    sub: identity.sub,
    email,
    emailVerified: identity.email_verified === true,
    picture: identity.picture || null,
    name: normalizePublicDisplayName(
      identity.name || [identity.given_name, identity.family_name].filter(Boolean).join(' ')),
    now: new Date().toISOString(),
  };

  return session.executeWrite(async tx => {
    // Consistent ordering: email, subject, then the selected User node.
    if (email) await lock(tx, `email:${email}`);
    await lock(tx, `subject:${identity.sub}`);

    const mapped = await tx.run(`MATCH (u:User {googleSub: $sub})
      RETURN elementId(u) AS nodeId, u.id AS id LIMIT 2`, params);
    if (mapped.records.length > 1) throw conflict();

    let nodeId: string;
    if (mapped.records.length === 1) {
      nodeId = mapped.records[0].get('nodeId') as string;
    } else {
      const collision = await tx.run(`MATCH (u:User)
        WHERE toLower(trim(u.email)) = $email RETURN u.id LIMIT 1`, params);
      if (collision.records.length) throw conflict();
      if (!verifiedEmail) {
        throw new GoogleIdentityError(400, 'A verified Google email is required to create an account');
      }
      const created = await tx.run(`CREATE (u:User {
        id: $id, email: $email, name: $name, googleSub: $sub,
        signupProvider: $signupProvider, createdAt: datetime($now)
      }) RETURN elementId(u) AS nodeId`, { ...params, id: nanoid(), signupProvider });
      nodeId = created.records[0].get('nodeId') as string;
    }

    const result = await tx.run(`MATCH (u:User) WHERE elementId(u) = $nodeId
      SET u.googleSub = $sub,
          u.googleEmail = $email,
          u.googleEmailVerified = $emailVerified,
          u.lastSeenAt = datetime($now),
          u.presenceStatus = 'available',
          u.avatarUrl = coalesce(u.avatarUrl, $picture)
      RETURN ${userProjection} AS user`, { ...params, nodeId });
    if (result.records.length !== 1) throw conflict();
    const user = result.records[0].get('user') as GoogleUser;
    if (typeof user.id !== 'string' || !user.id || typeof user.email !== 'string' || !user.email) throw conflict();
    // JWTs and downstream authorization identify users by id, not elementId.
    // Even a unique Google subject is unsafe if that id names multiple Users.
    // Check every resolution path inside the transaction so ambiguity rolls
    // back profile changes as well as preventing a session from escaping.
    const account = await tx.run(`MATCH (u:User {id: $userId})
      RETURN elementId(u) AS nodeId LIMIT 2`, { userId: user.id });
    if (account.records.length !== 1 || account.records[0].get('nodeId') !== nodeId) throw conflict();
    return user;
  });
}
