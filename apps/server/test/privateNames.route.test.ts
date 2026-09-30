import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ getContactProfile: vi.fn(), getPrivateName: vi.fn(), setPrivateName: vi.fn(), clearPrivateName: vi.fn() }));
vi.mock('../src/services/privateNames.js', () => ({ ...mocks,
  PrivateNameError: class extends Error { constructor(public status: number, message: string) { super(message); } },
}));
import routes from '../src/routes/privateNames.js';
const app = express(); app.use(express.json()); app.use('/api/private-names', routes);
const token = (userId: string) => `Bearer ${jwt.sign({ userId, email: `${userId}@example.test` }, process.env.JWT_SECRET || 'dev-secret-change-me')}`;
beforeEach(() => vi.clearAllMocks());
describe('private names HTTP boundary', () => {
  it('requires authentication for every verb', async () => {
    expect((await request(app).get('/api/private-names/bob/profile')).status).toBe(401);
    expect((await request(app).get('/api/private-names/bob')).status).toBe(401);
    expect((await request(app).put('/api/private-names/bob').send({ name: 'Buddy' })).status).toBe(401);
    expect((await request(app).delete('/api/private-names/bob')).status).toBe(401);
    expect(mocks.getPrivateName).not.toHaveBeenCalled();
    expect(mocks.setPrivateName).not.toHaveBeenCalled();
    expect(mocks.clearPrivateName).not.toHaveBeenCalled();
  });
  it('binds reads/edits/clear to signed-in owner regardless of query/body spoofing', async () => {
    mocks.getPrivateName.mockResolvedValue({ name: null });
    mocks.setPrivateName.mockResolvedValue({ name: 'Buddy' });
    mocks.clearPrivateName.mockResolvedValue({ name: null });
    const read = await request(app).get('/api/private-names/bob?ownerId=alice').set('Authorization', token('mallory'));
    expect(read.body).toEqual({ name: null });
    expect(read.headers['cache-control']).toBe('no-store');
    expect(mocks.getPrivateName).toHaveBeenCalledWith('mallory', 'bob');
    await request(app).put('/api/private-names/bob').set('Authorization', token('mallory')).send({ ownerId: 'alice', name: 'Buddy' });
    expect(mocks.setPrivateName).toHaveBeenCalledWith('mallory', 'bob', 'Buddy');
    await request(app).delete('/api/private-names/bob?ownerId=alice').set('Authorization', token('mallory'));
    expect(mocks.clearPrivateName).toHaveBeenCalledWith('mallory', 'bob');
  });
});


it('binds the independent official-profile read to the authenticated viewer', async () => {
  mocks.getContactProfile.mockResolvedValue({ id: 'bob', name: 'Official Bob', avatarUrl: null, isBot: false });
  const response = await request(app).get('/api/private-names/bob/profile?ownerId=alice').set('Authorization', token('mallory'));
  expect(response.status).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
  expect(mocks.getContactProfile).toHaveBeenCalledWith('mallory', 'bob');
  expect(response.body).toEqual({ id: 'bob', name: 'Official Bob', avatarUrl: null, isBot: false });
});
