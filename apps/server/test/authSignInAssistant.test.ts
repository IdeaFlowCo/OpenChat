import express from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const mockEnsureAssistantConversation = vi.fn().mockResolvedValue('conv-assistant-123');

vi.mock('../src/services/assistant.js', () => ({
  ensureAssistantConversation: (...args: unknown[]) => mockEnsureAssistantConversation(...args),
}));

vi.mock('../src/db.js', () => ({
  getDriver: () => ({
    session: () => ({
      run: vi.fn().mockResolvedValue({
        records: [
          {
            get: () => ({
              id: 'user-dev-test',
              email: 'dev@test.local',
              name: 'Dev Test',
            }),
          },
        ],
      }),
      close: vi.fn(),
    }),
  }),
}));

import authRouter from '../src/routes/auth.js';

describe('Auth sign-in ensures assistant conversation', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.JWT_SECRET = 'test-jwt-secret';
    const app = express();
    app.use(express.json());
    app.use('/api/auth', authRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it('calls ensureAssistantConversation during dev-login', async () => {
    mockEnsureAssistantConversation.mockClear();

    const response = await fetch(`${baseUrl}/api/auth/dev-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'dev@test.local', name: 'Dev Test' }),
    });

    expect(response.status).toBe(200);
    const data = (await response.json()) as { token: string; user: { id: string } };
    expect(data.token).toBeDefined();
    expect(data.user.id).toBe('user-dev-test');

    expect(mockEnsureAssistantConversation).toHaveBeenCalledTimes(1);
    expect(mockEnsureAssistantConversation).toHaveBeenCalledWith('user-dev-test', undefined);
  });
});
