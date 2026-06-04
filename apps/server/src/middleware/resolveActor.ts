/**
 * resolveActor — drop-in replacement for requireAuth that also accepts
 * Bearer oc_<...> agent API keys (OpenChat-7c9).
 *
 * Auth precedence:
 *   1. Bearer <jwt>  — validated against JWT_SECRET (existing picortex path)
 *   2. Bearer oc_<…> — looked up by keyPrefix, AES-256-GCM decrypted + compared
 *
 * Caches successful key lookups for ~60 s to avoid a Neo4j round-trip on every
 * request. Cache is invalidated immediately on revocation (DELETE /api/agent-keys/:id
 * purges the entry synchronously).
 */

import { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import { getDriver } from '../db.js';
import { validateToken } from './auth.js';

interface CacheEntry {
  userId: string;
  expiresAt: number | null; // unix ms — null means no expiry
  cachedAt: number;         // unix ms
}

// In-memory LRU-ish cache keyed by keyPrefix (first 12 chars of the full key).
const KEY_CACHE = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;

export function evictFromCache(keyPrefix: string): void {
  KEY_CACHE.delete(keyPrefix);
}

function getEncryptionKey(): Buffer | null {
  const hex = process.env.OC_KEY_ENCRYPTION_SECRET;
  if (!hex || hex.length !== 64) return null;
  return Buffer.from(hex, 'hex');
}

export function decryptKey(keyCiphertext: string, keyIv: string): string | null {
  const encKey = getEncryptionKey();
  if (!encKey) return null;

  try {
    const iv = Buffer.from(keyIv, 'hex');
    const ciphertextWithTag = Buffer.from(keyCiphertext, 'hex');
    // AES-256-GCM: last 16 bytes are the auth tag
    const authTag = ciphertextWithTag.slice(-16);
    const ciphertext = ciphertextWithTag.slice(0, -16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
  } catch {
    return null;
  }
}

async function resolveAgentKey(fullKey: string): Promise<string | null> {
  // keyPrefix = "oc_" + first 8 chars after "oc_" = first 11 chars total
  // e.g. key = "oc_AbCdEfGh..." → prefix = "oc_AbCdEfGh" (11 chars)
  const keyPrefix = fullKey.slice(0, 11);

  // Check in-memory cache first.
  const cached = KEY_CACHE.get(keyPrefix);
  if (cached) {
    const age = Date.now() - cached.cachedAt;
    if (age < CACHE_TTL_MS) {
      // Still valid — check expiry
      if (cached.expiresAt !== null && Date.now() > cached.expiresAt) return null;
      return cached.userId;
    }
    KEY_CACHE.delete(keyPrefix);
  }

  const session = getDriver().session();
  try {
    const result = await session.run(
      `MATCH (k:AgentKey {keyPrefix: $keyPrefix})
       WHERE k.revokedAt IS NULL
         AND (k.expiresAt IS NULL OR k.expiresAt > $now)
       RETURN k.keyCiphertext AS keyCiphertext,
              k.keyIv AS keyIv,
              k.ownerUserId AS ownerUserId,
              k.expiresAt AS expiresAt`,
      { keyPrefix, now: new Date().toISOString() }
    );

    if (result.records.length === 0) return null;

    const record = result.records[0];
    const keyCiphertext = record.get('keyCiphertext') as string;
    const keyIv = record.get('keyIv') as string;
    const ownerUserId = record.get('ownerUserId') as string;
    const expiresAt = record.get('expiresAt') as string | null;

    const plaintext = decryptKey(keyCiphertext, keyIv);
    if (!plaintext || plaintext !== fullKey) return null;

    // Cache the result.
    KEY_CACHE.set(keyPrefix, {
      userId: ownerUserId,
      expiresAt: expiresAt ? new Date(expiresAt).getTime() : null,
      cachedAt: Date.now(),
    });

    // Update lastUsedAt asynchronously — don't block the request.
    session.run(
      `MATCH (k:AgentKey {keyPrefix: $keyPrefix}) SET k.lastUsedAt = $now`,
      { keyPrefix, now: new Date().toISOString() }
    ).catch(() => { /* best-effort */ });

    return ownerUserId;
  } finally {
    await session.close();
  }
}

export async function resolveActor(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authorization header required' });
    return;
  }

  const token = authHeader.slice(7);

  // Try JWT first (picortex + existing clients).
  if (!token.startsWith('oc_')) {
    const user = validateToken(token);
    if (!user) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }
    req.user = user;
    next();
    return;
  }

  // Agent API key path.
  if (!getEncryptionKey()) {
    res.status(503).json({ error: 'Server not configured for agent keys' });
    return;
  }

  try {
    const userId = await resolveAgentKey(token);
    if (!userId) {
      res.status(401).json({ error: 'Invalid, expired, or revoked agent key' });
      return;
    }
    // Synthesise an AuthUser from the key's owner so route handlers work unchanged.
    req.user = { userId, email: '' };
    next();
  } catch (err) {
    console.error('resolveActor error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
