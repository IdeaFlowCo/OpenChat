/**
 * Agent API keys (OpenChat-7c9).
 *
 * Self-serve key minting + management for bots / scripts that want to talk to
 * OpenChat without holding a user JWT. Keys start with "oc_" and are stored
 * AES-256-GCM encrypted at rest; they are re-viewable any time via /reveal.
 *
 * Endpoints:
 *   POST   /api/agent-keys               — mint a new key
 *   GET    /api/agent-keys               — list caller's keys (no plaintext)
 *   GET    /api/agent-keys/:id/reveal    — return plaintext (+ audit log)
 *   PATCH  /api/agent-keys/:id           — rename / change scopes
 *   DELETE /api/agent-keys/:id           — revoke (sets revokedAt)
 *
 * All endpoints require a valid JWT (agent keys cannot mint other keys).
 */

import { Router, Request, Response } from 'express';
import crypto from 'node:crypto';
import { nanoid } from 'nanoid';
import { getDriver } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { evictFromCache } from '../middleware/resolveActor.js';

const router = Router();

// ── Encryption helpers ────────────────────────────────────────────────────────

function getEncryptionKey(): Buffer | null {
  const hex = process.env.OC_KEY_ENCRYPTION_SECRET;
  if (!hex || hex.length !== 64) return null;
  return Buffer.from(hex, 'hex');
}

/**
 * AES-256-GCM encrypt.
 * Returns { keyCiphertext, keyIv } where ciphertext has the 16-byte auth tag
 * appended (so a single hex string carries both).
 */
function encryptKey(plaintext: string): { keyCiphertext: string; keyIv: string } | null {
  const encKey = getEncryptionKey();
  if (!encKey) return null;

  const iv = crypto.randomBytes(12); // 96-bit IV for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Store ciphertext + tag together so we only need one field.
  const keyCiphertext = Buffer.concat([encrypted, tag]).toString('hex');
  const keyIv = iv.toString('hex');
  return { keyCiphertext, keyIv };
}

/** Decrypt a key previously encrypted by encryptKey. Returns null on failure. */
function decryptKey(keyCiphertext: string, keyIv: string): string | null {
  const encKey = getEncryptionKey();
  if (!encKey) return null;

  try {
    const iv = Buffer.from(keyIv, 'hex');
    const ciphertextWithTag = Buffer.from(keyCiphertext, 'hex');
    const authTag = ciphertextWithTag.slice(-16);
    const ciphertext = ciphertextWithTag.slice(0, -16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// ── POST /api/agent-keys ──────────────────────────────────────────────────────

router.post('/', requireAuth, async (req: Request, res: Response) => {
  if (!getEncryptionKey()) {
    res.status(503).json({ error: 'Server not configured for agent keys' });
    return;
  }

  const { name, scopes, agentName, agentVersion, expiresAt } = req.body as {
    name?: string;
    scopes?: string[];
    agentName?: string;
    agentVersion?: string;
    expiresAt?: string;
  };

  if (!name || typeof name !== 'string' || !name.trim()) {
    res.status(400).json({ error: 'name is required' });
    return;
  }

  // Generate plaintext key: "oc_" + 24 random bytes in base64url (32 chars).
  const randomPart = crypto.randomBytes(24).toString('base64url');
  const plainKey = `oc_${randomPart}`;

  // keyPrefix = first 11 chars of the full key ("oc_" + first 8 chars of random part).
  const keyPrefix = plainKey.slice(0, 11);

  const encrypted = encryptKey(plainKey);
  if (!encrypted) {
    res.status(503).json({ error: 'Encryption failed' });
    return;
  }

  const id = nanoid();
  const createdAt = new Date().toISOString();
  const resolvedScopes: string[] = Array.isArray(scopes) && scopes.length > 0
    ? scopes
    : ['read', 'write'];
  const userId = req.user!.userId;

  const session = getDriver().session();
  try {
    await session.run(
      `MATCH (u:User {id: $userId})
       CREATE (k:AgentKey {
         id: $id,
         ownerUserId: $userId,
         name: $name,
         keyPrefix: $keyPrefix,
         keyCiphertext: $keyCiphertext,
         keyIv: $keyIv,
         scopes: $scopes,
         agentName: $agentName,
         agentVersion: $agentVersion,
         expiresAt: $expiresAt,
         createdAt: $createdAt,
         lastUsedAt: null,
         revokedAt: null
       })
       CREATE (u)-[:OWNS_KEY]->(k)`,
      {
        id,
        userId,
        name: name.trim(),
        keyPrefix,
        keyCiphertext: encrypted.keyCiphertext,
        keyIv: encrypted.keyIv,
        scopes: resolvedScopes,
        agentName: agentName ?? null,
        agentVersion: agentVersion ?? null,
        expiresAt: expiresAt ?? null,
        createdAt,
      }
    );
  } finally {
    await session.close();
  }

  res.status(201).json({
    id,
    name: name.trim(),
    keyPrefix,
    key: plainKey,
    scopes: resolvedScopes,
    createdAt,
    expiresAt: expiresAt ?? null,
  });
});

// ── GET /api/agent-keys ───────────────────────────────────────────────────────

router.get('/', requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const session = getDriver().session();
  try {
    const result = await session.run(
      `MATCH (u:User {id: $userId})-[:OWNS_KEY]->(k:AgentKey)
       RETURN k { .id, .name, .keyPrefix, .scopes, .agentName, .agentVersion,
                  .createdAt, .lastUsedAt, .expiresAt, .revokedAt }
              AS key
       ORDER BY k.createdAt DESC`,
      { userId }
    );
    const keys = result.records.map((r) => r.get('key'));
    res.json(keys);
  } finally {
    await session.close();
  }
});

// ── GET /api/agent-keys/:id/reveal ───────────────────────────────────────────

router.get('/:id/reveal', requireAuth, async (req: Request, res: Response) => {
  if (!getEncryptionKey()) {
    res.status(503).json({ error: 'Server not configured for agent keys' });
    return;
  }

  const userId = req.user!.userId;
  const { id } = req.params;
  const session = getDriver().session();

  try {
    const result = await session.run(
      `MATCH (u:User {id: $userId})-[:OWNS_KEY]->(k:AgentKey {id: $id})
       RETURN k.keyCiphertext AS keyCiphertext, k.keyIv AS keyIv, k.name AS name`,
      { userId, id }
    );

    if (result.records.length === 0) {
      res.status(404).json({ error: 'Key not found' });
      return;
    }

    const record = result.records[0];
    const keyCiphertext = record.get('keyCiphertext') as string;
    const keyIv = record.get('keyIv') as string;
    const name = record.get('name') as string;

    const plainKey = decryptKey(keyCiphertext, keyIv);
    if (!plainKey) {
      res.status(500).json({ error: 'Failed to decrypt key' });
      return;
    }

    // Write audit log entry.
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
      || req.socket.remoteAddress
      || 'unknown';
    const userAgent = req.headers['user-agent'] ?? 'unknown';

    await session.run(
      `CREATE (:AgentKeyAuditLog {
         id: $auditId,
         keyId: $keyId,
         ownerUserId: $userId,
         action: 'reveal',
         at: $at,
         ip: $ip,
         userAgent: $userAgent
       })`,
      {
        auditId: nanoid(),
        keyId: id,
        userId,
        at: new Date().toISOString(),
        ip,
        userAgent,
      }
    );

    res.json({ id, name, key: plainKey });
  } finally {
    await session.close();
  }
});

// ── PATCH /api/agent-keys/:id ────────────────────────────────────────────────

router.patch('/:id', requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { id } = req.params;
  const { name, scopes } = req.body as { name?: string; scopes?: string[] };

  if (name === undefined && scopes === undefined) {
    res.status(400).json({ error: 'Provide name and/or scopes to update' });
    return;
  }

  const session = getDriver().session();
  try {
    const setClauses: string[] = [];
    const params: Record<string, unknown> = { userId, id };

    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) {
        res.status(400).json({ error: 'name must be a non-empty string' });
        return;
      }
      setClauses.push('k.name = $name');
      params['name'] = name.trim();
    }

    if (scopes !== undefined) {
      if (!Array.isArray(scopes)) {
        res.status(400).json({ error: 'scopes must be an array' });
        return;
      }
      setClauses.push('k.scopes = $scopes');
      params['scopes'] = scopes;
    }

    const result = await session.run(
      `MATCH (u:User {id: $userId})-[:OWNS_KEY]->(k:AgentKey {id: $id})
       WHERE k.revokedAt IS NULL
       SET ${setClauses.join(', ')}
       RETURN k { .id, .name, .keyPrefix, .scopes, .createdAt, .expiresAt, .lastUsedAt, .revokedAt } AS key`,
      params
    );

    if (result.records.length === 0) {
      res.status(404).json({ error: 'Key not found or already revoked' });
      return;
    }

    res.json(result.records[0].get('key'));
  } finally {
    await session.close();
  }
});

// ── DELETE /api/agent-keys/:id ───────────────────────────────────────────────

router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { id } = req.params;
  const session = getDriver().session();

  try {
    const result = await session.run(
      `MATCH (u:User {id: $userId})-[:OWNS_KEY]->(k:AgentKey {id: $id})
       WHERE k.revokedAt IS NULL
       SET k.revokedAt = $now
       RETURN k.keyPrefix AS keyPrefix`,
      { userId, id, now: new Date().toISOString() }
    );

    if (result.records.length === 0) {
      res.status(404).json({ error: 'Key not found or already revoked' });
      return;
    }

    // Evict from the in-memory resolver cache immediately.
    const keyPrefix = result.records[0].get('keyPrefix') as string;
    evictFromCache(keyPrefix);

    res.json({ ok: true });
  } finally {
    await session.close();
  }
});

export default router;
