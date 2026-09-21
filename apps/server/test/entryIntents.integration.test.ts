import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { getDriver } from '../src/db.js';
import { nanoid } from 'nanoid';
import entryIntentsRouter from '../src/routes/entryIntents.js';

const uri = process.env.NEO4J_TEST_URI;
const user = process.env.NEO4J_TEST_USER;
const password = process.env.NEO4J_TEST_PASSWORD;
const integration = uri && user && password ? describe : describe.skip;

// Minimal mock app for testing
const app = express();
app.use(express.json());
// Mock requireAuth middleware
app.use((req: any, res: any, next: any) => {
  req.user = { userId: req.headers.authorization?.split(' ')[1] };
  next();
});
app.use('/api', entryIntentsRouter);

integration('Pending Entries API', () => {
  let userId: string;

  beforeAll(async () => {
    userId = `test-user-${nanoid()}`;
    const session = getDriver().session();
    await session.run(`CREATE (u:User {id: $userId})`, { userId });
    await session.close();
  });

  afterAll(async () => {
    const session = getDriver().session();
    await session.run(`MATCH (u:User {id: $userId}) DETACH DELETE u`, { userId });
    await session.run(`MATCH (pe:PendingEntry) WHERE NOT ()-[:HAS_PENDING_ENTRY]->(pe) DELETE pe`);
    await session.close();
  });

  it('can create and list pending entries', async () => {
    const clientIntentId = nanoid();
    const res = await request(app)
      .post('/api/entry-intents')
      .set('Authorization', `Bearer ${userId}`)
      .send({
        clientIntentId,
        target: { kind: 'group', token: 'test-token' },
        continuation: 'native',
      });
    
    expect(res.status).toBe(200);
    expect(res.body.id).toBeDefined();

    const listRes = await request(app)
      .get('/api/entry-intents')
      .set('Authorization', `Bearer ${userId}`);
    
    expect(listRes.status).toBe(200);
    expect(listRes.body.length).toBeGreaterThan(0);
    expect(listRes.body[0].clientIntentId).toBe(clientIntentId);
    expect(listRes.body[0].status).toBe('pending');
  });

  it('expires old entries', async () => {
    const clientIntentId = nanoid();
    const session = getDriver().session();
    await session.run(`
      MATCH (u:User {id: $userId})
      CREATE (u)-[:HAS_PENDING_ENTRY]->(pe:PendingEntry {
        id: $id,
        clientIntentId: $clientIntentId,
        targetKind: 'group',
        targetValue: 'test-token-expired',
        status: 'pending',
        createdAt: datetime(),
        expiresAt: datetime() - duration('PT1H')
      })
    `, { userId, clientIntentId, id: nanoid() });
    await session.close();

    const listRes = await request(app)
      .get('/api/entry-intents')
      .set('Authorization', `Bearer ${userId}`);
    
    expect(listRes.status).toBe(200);
    // The expired one should not be returned
    const found = listRes.body.find((e: any) => e.clientIntentId === clientIntentId);
    expect(found).toBeUndefined();
  });

  it('completes entry', async () => {
    const clientIntentId = nanoid();
    const createRes = await request(app)
      .post('/api/entry-intents')
      .set('Authorization', `Bearer ${userId}`)
      .send({
        clientIntentId,
        target: { kind: 'group', token: 'test-token-2' },
        continuation: 'native',
      });
    
    const id = createRes.body.id;

    await request(app)
      .post(`/api/entry-intents/${id}/complete`)
      .set('Authorization', `Bearer ${userId}`)
      .expect(200);

    const listRes = await request(app)
      .get('/api/entry-intents')
      .set('Authorization', `Bearer ${userId}`);
    
    const found = listRes.body.find((e: any) => e.id === id);
    expect(found).toBeUndefined();
  });
});