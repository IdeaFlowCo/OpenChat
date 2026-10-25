import type { Request, Response } from 'express';
import neo4j from 'neo4j-driver';
import { getConnectorPrincipal } from '../lib/ideaflowConnector.js';
import { getDriver } from '../db.js';
import { classifyContactDiscoveryQuery } from '../privacy/contactDiscovery.js';
import { normalizePublicDisplayName } from '../privacy/profilePrivacy.js';

// This is a projection, never a session/recipient/conversation provisioner.
// Preserve contact discovery's known-graph and name/email privacy rules, but
// do not mistake an automatically created empty DM for a human conversation.
export const PEOPLE_SUGGESTIONS_QUERY = `
  MATCH (actor:User {id: $userId}), (person:User)
  WHERE person.id <> actor.id AND NOT coalesce(person.isBot, false)
    AND NOT (actor)-[:BLOCKED]-(person)
  OPTIONAL MATCH (connection:OpenChatConnection)
  WHERE connection.pairKey = CASE WHEN actor.id < person.id
    THEN '["' + actor.id + '","' + person.id + '"]'
    ELSE '["' + person.id + '","' + actor.id + '"]' END
  WITH actor, person, coalesce(connection.state = 'accepted', false) AS connected,
    EXISTS { (actor)-[:PARTICIPATES_IN]->(:Conversation)<-[:PARTICIPATES_IN]-(person) } AS known
  WHERE ($empty AND (known OR connected))
    OR (person.ideaflowIssuer = $issuer AND person.ideaflowSub IN $subjects
      AND (known OR connected OR (coalesce(person.discoveryMode, 'name') = 'name' AND NOT coalesce(person.name, '') CONTAINS '@')))
    OR ($name <> '' AND toLower(coalesce(person.name, '')) CONTAINS $name
      AND (known OR connected OR (coalesce(person.discoveryMode, 'name') = 'name'
        AND NOT coalesce(person.name, '') CONTAINS '@')))
    OR ($email <> '' AND toLower(person.email) = $email
      AND (known OR connected OR coalesce(person.discoveryMode, 'name') <> 'hidden'))
  CALL {
    WITH actor, person
    OPTIONAL MATCH (actor)-[:PARTICIPATES_IN]->(dm:Conversation {type: 'direct'})<-[:PARTICIPATES_IN]-(person)
    // Socket writes may omit IN_CONVERSATION; conversationId is canonical.
    OPTIONAL MATCH (message:Message {conversationId: dm.id})
    WHERE message.deletedAt IS NULL AND message.messageType = 'text'
      AND message.senderId IN [actor.id, person.id]
      AND message.agentKeyId IS NULL AND message.connectorAgentId IS NULL
      AND message.importedAt IS NULL
      AND NOT coalesce(message.viaAssistant, false) AND NOT coalesce(message.viaSecretary, false)
    RETURN max(message.createdAt) AS lastChattedAt
  }
  RETURN person.id AS userId, person.name AS name,
    CASE WHEN person.ideaflowIssuer = $issuer AND person.ideaflowSub IS NOT NULL
      AND person.ideaflowSub <> '' THEN person.ideaflowSub ELSE null END AS subject,
    connected, lastChattedAt IS NOT NULL AS chatted,
    CASE WHEN lastChattedAt IS NULL THEN null ELSE lastChattedAt.epochMillis END AS lastChattedAt
  ORDER BY CASE WHEN $name <> '' AND toLower(coalesce(person.name, '')) = $name THEN 0 ELSE 1 END,
    CASE WHEN $name <> '' AND toLower(coalesce(person.name, '')) STARTS WITH $name THEN 0 ELSE 1 END,
    CASE WHEN lastChattedAt IS NOT NULL THEN 0 WHEN connected THEN 1 ELSE 2 END,
    lastChattedAt DESC, toLower(coalesce(person.name, '')), userId
  LIMIT $limit
`;

export async function peopleSuggestions(req: Request, res: Response): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  const required = getConnectorPrincipal(req) ? 'openchat:read' : 'read';
  if (req.agentScopes && !req.agentScopes.includes(required)) {
    res.status(404).json({ error: 'Not available to this key' }); return;
  }
  const input = req.method === 'POST' ? req.body : req.query;
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['q', 'limit', 'subjects'].includes(key))) {
    res.status(400).json({ error: 'Invalid people query' }); return;
  }
  if (req.method !== 'POST' && input.subjects !== undefined) {
    res.status(400).json({ error: 'Identity candidates require POST' }); return;
  }
  const subjects = input.subjects ?? [];
  if (!Array.isArray(subjects) || subjects.length > 50 || subjects.some((v: unknown) => typeof v !== 'string' || !v || v.length > 512 || Array.from(v).some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127))) {
    res.status(400).json({ error: 'Invalid person identities' }); return;
  }
  if (typeof input.q !== 'undefined' && (typeof input.q !== 'string' || input.q.length > 100)) {
    res.status(400).json({ error: 'Invalid people query' }); return;
  }
  const discovery = classifyContactDiscoveryQuery(input.q);
  if (discovery.kind === 'invalid' || discovery.kind === 'self') { res.json({ people: [] }); return; }
  const requested = input.limit === undefined ? 10 : Number(input.limit);
  if (!Number.isInteger(requested) || requested < 1 || requested > 100) {
    res.status(400).json({ error: 'Invalid people limit' }); return;
  }
  const session = getDriver().session({ defaultAccessMode: 'READ' });
  try {
    const result = await session.run(PEOPLE_SUGGESTIONS_QUERY, {
      userId: req.user!.userId, issuer: 'https://id.ideaflow.app/api/auth',
      subjects, empty: discovery.kind === 'empty' && subjects.length === 0,
      name: discovery.kind === 'name' ? discovery.normalized : '',
      email: discovery.kind === 'email' ? discovery.normalized : '', limit: neo4j.int(requested),
    });
    res.json({ people: result.records.map(record => {
      const timestamp = record.get('lastChattedAt');
      const lastChattedAt = timestamp === null ? null : Number(timestamp);
      return {
        userId: record.get('userId'), displayName: normalizePublicDisplayName(record.get('name')),
        identity: record.get('subject') ? { issuer: 'https://id.ideaflow.app/api/auth', subject: record.get('subject') } : null,
        connected: record.get('connected') === true,
        chatted: record.get('chatted') === true && lastChattedAt !== null && Number.isFinite(lastChattedAt),
        lastChattedAt: lastChattedAt !== null && Number.isFinite(lastChattedAt) ? lastChattedAt : null,
      };
    }) });
  } catch { res.status(503).json({ error: 'People are temporarily unavailable' }); }
  finally { await session.close(); }
}
