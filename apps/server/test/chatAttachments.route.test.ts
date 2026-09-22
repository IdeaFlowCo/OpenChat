import express from 'express';
import jwt from 'jsonwebtoken';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  close: vi.fn(async () => {}),
  getSignedUrl: vi.fn(),
}));

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: mocks.getSignedUrl,
}));

const mockSession = {
  run: mocks.run,
  close: mocks.close,
  executeRead: vi.fn(async (cb) => cb({ run: mocks.run })),
  executeWrite: vi.fn(async (cb) => cb({ run: mocks.run })),
};

vi.mock('../src/db.js', () => ({
  getDriver: () => ({
    session: () => mockSession,
  }),
  getDriverForRequest: () => ({
    session: () => mockSession,
  }),
}));

import chatRoutes from '../src/routes/chat.js';

describe('chat attachments route', () => {
  let server: Server;
  let baseUrl: string;
  let authorization: string;

  beforeAll(async () => {
    process.env.JWT_SECRET = 'attachments-test-secret';
    process.env.S3_BUCKET = 'test-bucket';
    process.env.S3_ENDPOINT = 'https://test-endpoint';

    const app = express();
    app.use(express.json());
    app.use('/api/chat', chatRoutes);
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    authorization = `Bearer ${jwt.sign(
      { userId: 'test-user', email: 'test@example.com' },
      process.env.JWT_SECRET,
    )}`;
  });

  beforeEach(() => {
    mocks.run.mockReset();
    mocks.close.mockClear();
    mocks.getSignedUrl.mockReset();
    mockSession.executeRead.mockClear();
    mockSession.executeWrite.mockClear();
  });

  afterAll(async () => {
    delete process.env.JWT_SECRET;
    delete process.env.S3_BUCKET;
    delete process.env.S3_ENDPOINT;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  it('rejects upload presign if sizeBytes is missing or invalid', async () => {
    const res = await fetch(`${baseUrl}/api/chat/attachments/presign`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
      }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/sizeBytes must be between/);
  });

  it('returns a presigned URL when valid parameters are provided', async () => {
    mocks.getSignedUrl.mockResolvedValue('https://presigned.url');

    const res = await fetch(`${baseUrl}/api/chat/attachments/presign`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1024,
      }),
    });
    
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.putUrl).toBe('https://presigned.url');
    expect(data.getUrl).toMatch(/^https:\/\/test-endpoint\/test-bucket\/attachments\/test-user\//);
    expect(data.key).toMatch(/^attachments\/test-user\/.*?\/photo\.jpg$/);
  });
});