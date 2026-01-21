import neo4j, { Driver } from 'neo4j-driver';

let driver: Driver | null = null;

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
