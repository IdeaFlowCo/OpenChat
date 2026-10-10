// Which of a member's conversation partners have a shared Ideaflow identity
// (POST /api/unlinked/identities). The viewer is the shared inbox for exactly
// this issuer/subject; only users who share a conversation with it are
// considered, blocked pairs (either direction) are excluded, and nothing but
// the partner id and subject is returned.
export const UNLINKED_PARTNER_IDENTITIES_QUERY = `
      MATCH (viewer:User {ideaflowIdentityKey: $key})
      WHERE viewer.ideaflowIssuer = $issuer AND viewer.ideaflowSub = $subject
      UNWIND $userIds AS otherId
      MATCH (viewer)-[:PARTICIPATES_IN]->(c:Conversation)<-[:PARTICIPATES_IN]-(other:User {id: otherId})
      WHERE other.id <> viewer.id AND other.ideaflowIssuer = $issuer AND other.ideaflowSub IS NOT NULL
        AND NOT (viewer)-[:BLOCKED]-(other)
      RETURN DISTINCT other.id AS userId, other.ideaflowSub AS subject
    `;
