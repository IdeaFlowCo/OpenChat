import { Session } from 'neo4j-driver';
import { normalizePublicDisplayName } from '../privacy/profilePrivacy.js';

export type PublicPersonProjection = {
  id: string;
  name: string;
  avatarUrl: string | null;
  isBot: boolean;
};

export async function resolvePublicPersonProjection(session: Session, userId: string): Promise<PublicPersonProjection | null> {
  const result = await session.run(
    `MATCH (u:User {id: $userId})
     WHERE coalesce(u.discoveryMode, 'name') <> 'hidden'
     RETURN u { .id, .name, .avatarUrl, .isBot } AS user LIMIT 1`,
    { userId }
  );

  if (result.records.length === 0) return null;

  const user = result.records[0].get('user') as {
    id: string;
    name?: string | null;
    avatarUrl?: string | null;
    isBot?: boolean | null;
  };

  return {
    id: user.id,
    name: normalizePublicDisplayName(user.name),
    avatarUrl: user.avatarUrl || null,
    isBot: !!user.isBot,
  };
}