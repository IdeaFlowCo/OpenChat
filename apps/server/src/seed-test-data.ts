import 'dotenv/config';
import { nanoid } from 'nanoid';
import { getDriver, closeDatabase } from './db.js';

const TEST_USERS = {
  alice: { email: 'alice@test.com', name: 'Alice Test' },
  bob: { email: 'bob@test.com', name: 'Bob Test' }
};

const SAMPLE_MESSAGES = [
  { from: 'alice', content: 'Hey Bob! How are you doing?' },
  { from: 'bob', content: 'Hi Alice! I am doing great, thanks for asking. How about you?' },
  { from: 'alice', content: 'Pretty good! Just working on some new features for the chat app.' },
  { from: 'bob', content: 'Nice! Anything exciting?' },
  { from: 'alice', content: 'Yeah, we just added real-time presence indicators. You should see when someone is online now!' },
  { from: 'bob', content: 'That is awesome! I love those little green dots 💚' },
  { from: 'alice', content: 'Haha exactly! Also working on status messages next.' },
  { from: 'bob', content: 'Like "In a meeting" or "Out for lunch"?' },
  { from: 'alice', content: 'Exactly! Makes it easier to know when someone is available to chat.' },
  { from: 'bob', content: 'Great idea. Let me know if you need any help testing!' },
  { from: 'alice', content: 'Will do! Thanks Bob 🙏' },
  { from: 'bob', content: 'Anytime! Talk soon.' },
];

async function seedTestData() {
  console.log('Connecting to database...');
  const driver = getDriver();
  const session = driver.session();

  try {
    console.log('Looking up test users...');

    // Get alice and bob user IDs
    const aliceResult = await session.run(
      'MATCH (u:User {email: $email}) RETURN u.id as id',
      { email: TEST_USERS.alice.email }
    );
    const bobResult = await session.run(
      'MATCH (u:User {email: $email}) RETURN u.id as id',
      { email: TEST_USERS.bob.email }
    );

    if (aliceResult.records.length === 0 || bobResult.records.length === 0) {
      console.error('Test users not found. Please ensure alice@test.com and bob@test.com exist in Noos.');
      return;
    }

    const aliceId = aliceResult.records[0].get('id');
    const bobId = bobResult.records[0].get('id');
    console.log(`Found users: alice=${aliceId}, bob=${bobId}`);

    // Ensure users have presence properties
    await session.run(`
      MATCH (u:User {id: $id})
      SET u.presenceStatus = coalesce(u.presenceStatus, 'available'),
          u.lastSeenAt = coalesce(u.lastSeenAt, datetime())
    `, { id: aliceId });
    await session.run(`
      MATCH (u:User {id: $id})
      SET u.presenceStatus = coalesce(u.presenceStatus, 'available'),
          u.lastSeenAt = coalesce(u.lastSeenAt, datetime())
    `, { id: bobId });

    // Check if conversation already exists
    const existingConv = await session.run(`
      MATCH (a:User {id: $aliceId})-[:PARTICIPATES_IN]->(c:Conversation {type: 'direct'})<-[:PARTICIPATES_IN]-(b:User {id: $bobId})
      RETURN c.id as id
    `, { aliceId, bobId });

    let conversationId: string;

    if (existingConv.records.length > 0) {
      conversationId = existingConv.records[0].get('id');
      console.log(`Found existing conversation: ${conversationId}`);

      // Check if messages exist
      const msgCount = await session.run(
        'MATCH (m:Message {conversationId: $convId}) RETURN count(m) as count',
        { convId: conversationId }
      );
      const count = msgCount.records[0].get('count').toNumber();

      if (count > 0) {
        console.log(`Conversation already has ${count} messages. Skipping seed.`);
        return;
      }
    } else {
      // Create conversation
      conversationId = nanoid();
      const now = new Date().toISOString();

      console.log('Creating conversation...');
      await session.run(`
        CREATE (c:Conversation {
          id: $id,
          type: 'direct',
          createdAt: datetime($now),
          updatedAt: datetime($now),
          lastMessageAt: datetime($now)
        })
        WITH c
        MATCH (alice:User {id: $aliceId}), (bob:User {id: $bobId})
        CREATE (alice)-[:PARTICIPATES_IN {joinedAt: datetime($now), role: 'member'}]->(c)
        CREATE (bob)-[:PARTICIPATES_IN {joinedAt: datetime($now), role: 'member'}]->(c)
        RETURN c.id
      `, { id: conversationId, now, aliceId, bobId });

      console.log(`Created conversation: ${conversationId}`);
    }

    // Add messages with realistic timestamps (spread over last hour)
    console.log('Adding messages...');
    const baseTime = Date.now() - (60 * 60 * 1000); // 1 hour ago
    const interval = (60 * 60 * 1000) / SAMPLE_MESSAGES.length; // Spread evenly

    for (let i = 0; i < SAMPLE_MESSAGES.length; i++) {
      const msg = SAMPLE_MESSAGES[i];
      const senderId = msg.from === 'alice' ? aliceId : bobId;
      const timestamp = new Date(baseTime + (i * interval)).toISOString();
      const messageId = nanoid();

      await session.run(`
        MATCH (c:Conversation {id: $convId})
        MATCH (sender:User {id: $senderId})
        CREATE (m:Message {
          id: $msgId,
          content: $content,
          senderId: $senderId,
          conversationId: $convId,
          messageType: 'text',
          createdAt: datetime($timestamp)
        })
        CREATE (m)-[:IN_CONVERSATION]->(c)
        CREATE (sender)-[:SENT]->(m)
        SET c.updatedAt = datetime($timestamp),
            c.lastMessageAt = datetime($timestamp),
            c.lastMessagePreview = $content
      `, {
        convId: conversationId,
        msgId: messageId,
        content: msg.content,
        senderId,
        timestamp
      });
    }

    console.log(`Added ${SAMPLE_MESSAGES.length} messages to conversation`);
    console.log('Seed complete!');
    console.log('\nTest accounts:');
    console.log('  alice@test.com / Test123!');
    console.log('  bob@test.com / Test123!');

  } catch (error) {
    console.error('Seed failed:', error);
  } finally {
    await session.close();
    await closeDatabase();
  }
}

// Run if called directly
seedTestData().catch(console.error);
