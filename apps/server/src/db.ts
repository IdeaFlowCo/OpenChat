import neo4j, { Driver } from 'neo4j-driver';

let driver: Driver | null = null;

/**
 * Get Neo4j driver connection.
 *
 * IMPORTANT: In production, this uses the SHARED Noos Neo4j database
 * (same as Thoughtstreams, thoughtstream-gemini-jacob, and noos/client).
 * The default port 7690 is only for local development isolation.
 * Production config is set via docker-compose.prod.yml → NEO4J_URI=bolt://noos_neo4j:7687
 */
export function getDriver(): Driver {
  if (!driver) {
    const uri = process.env.NEO4J_URI || 'bolt://localhost:7690';
    const user = process.env.NEO4J_USER || 'neo4j';
    const password = process.env.NEO4J_PASSWORD || '';

    driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
  }
  return driver;
}

export async function initDatabase(): Promise<void> {
  const session = getDriver().session();

  try {
    // Create constraints for Conversation
    await session.run(`
      CREATE CONSTRAINT conversation_id IF NOT EXISTS
      FOR (c:Conversation) REQUIRE c.id IS UNIQUE
    `);

    // Create constraints for Message
    await session.run(`
      CREATE CONSTRAINT message_id IF NOT EXISTS
      FOR (m:Message) REQUIRE m.id IS UNIQUE
    `);

    await session.run(`
      CREATE CONSTRAINT message_match_context IF NOT EXISTS
      FOR (m:Message) REQUIRE m.matchContextKey IS UNIQUE
    `);

    await session.run(`
      CREATE CONSTRAINT message_agent_delivery IF NOT EXISTS
      FOR (m:Message) REQUIRE m.agentDeliveryKey IS UNIQUE
    `);

    await session.run(`
      CREATE CONSTRAINT conversation_direct_pair IF NOT EXISTS
      FOR (c:Conversation) REQUIRE c.directPairKey IS UNIQUE
    `);

    // Create indexes for common queries
    await session.run(`
      CREATE INDEX message_conversation IF NOT EXISTS
      FOR (m:Message) ON (m.conversationId)
    `);

    await session.run(`
      CREATE INDEX message_created IF NOT EXISTS
      FOR (m:Message) ON (m.createdAt)
    `);

    await session.run(`
      CREATE INDEX user_presence IF NOT EXISTS
      FOR (u:User) ON (u.presenceStatus)
    `);

    // Additive centralized identity mapping. A single-property key keeps this
    // compatible with Neo4j Community while preventing two OpenChat User nodes
    // from claiming the same IdeaFlow ID issuer+subject pair.
    await session.run(`
      CREATE CONSTRAINT openchat_user_ideaflow_identity IF NOT EXISTS
      FOR (u:User) REQUIRE u.ideaflowIdentityKey IS UNIQUE
    `);

    // Google binding transactions serialize by email and subject without
    // migrating or imposing uniqueness on legacy shared User data.
    await session.run(`
      CREATE CONSTRAINT openchat_google_auth_lock IF NOT EXISTS
      FOR (lock:OpenChatGoogleAuthLock) REQUIRE lock.key IS UNIQUE
    `);
    await session.run(`
      CREATE INDEX openchat_user_google_subject IF NOT EXISTS
      FOR (u:User) ON (u.googleSub)
    `);

    // Context Lane index
    await session.run(`
      CREATE INDEX thought_lane_conversation IF NOT EXISTS
      FOR (t:Thought) ON (t.lane, t.conversationId)
    `);

    // AgentKey constraints (OpenChat-7c9)
    await session.run(`
      CREATE CONSTRAINT agent_key_id IF NOT EXISTS
      FOR (k:AgentKey) REQUIRE k.id IS UNIQUE
    `);

    await session.run(`
      CREATE INDEX agent_key_prefix IF NOT EXISTS
      FOR (k:AgentKey) ON (k.keyPrefix)
    `);

    // Phone number hash index (OpenChat-xf4 prep) — zero-cost prophylactic
    // so a future contacts-matching query (when/if phone sign-in ships) hits
    // an index from day one. The field will only exist on User nodes after
    // phone sign-in is enabled; the index is safe to create now.
    await session.run(`
      CREATE INDEX user_phone_hash IF NOT EXISTS
      FOR (u:User) ON (u.phoneNumberHash)
    `);

    // Pending entries (OpenChat-invite-onboarding)
    await session.run(`
      CREATE CONSTRAINT pending_entry_id IF NOT EXISTS
      FOR (pe:PendingEntry) REQUIRE pe.id IS UNIQUE
    `);

    await session.run(`
      CREATE INDEX pending_entry_expires_at IF NOT EXISTS
      FOR (pe:PendingEntry) ON (pe.expiresAt)
    `);

    // AddMe cards (OpenChat-whxy.2): public lookups are by token.
    await session.run(`
      CREATE CONSTRAINT addme_card_token IF NOT EXISTS
      FOR (card:AddMeCard) REQUIRE card.token IS UNIQUE
    `);

    // One durable lifecycle per unordered pair, independent of conversations.
    await session.run(`CREATE CONSTRAINT unlinked_connection_sync_request IF NOT EXISTS
      FOR (receipt:UnlinkedConnectionSync) REQUIRE receipt.requestId IS UNIQUE`);
    await session.run(`
      CREATE CONSTRAINT friend_connection_pair IF NOT EXISTS
      FOR (connection:OpenChatConnection) REQUIRE connection.pairKey IS UNIQUE
    `);
    await session.run(`CREATE INDEX friend_connection_first IF NOT EXISTS FOR (connection:OpenChatConnection) ON (connection.firstId)`);
    await session.run(`CREATE INDEX friend_connection_second IF NOT EXISTS FOR (connection:OpenChatConnection) ON (connection.secondId)`);

    // Context remains separate from ordinary Message delivery and indexing.
    await session.run(`CREATE INDEX context_posts_page IF NOT EXISTS FOR (t:Thought) ON (t.conversationId, t.lane, t.createdAt)`);
    await session.run(`CREATE INDEX context_requests_recipient IF NOT EXISTS FOR (r:ContextAgentRequest) ON (r.agentKeyId, r.ownerUserId)`);
    await session.run(`CREATE INDEX context_requests_source IF NOT EXISTS FOR (r:ContextAgentRequest) ON (r.postId, r.sourceRevision, r.agentKeyId)`);
    await session.run(`CREATE INDEX context_requests_budget IF NOT EXISTS FOR (r:ContextAgentRequest) ON (r.requesterId, r.createdAt)`);

    console.log('Database constraints and indexes initialized');
  } finally {
    await session.close();
  }
}

export async function closeDatabase(): Promise<void> {
  if (driver) {
    await driver.close();
    driver = null;
  }
}
