/**
 * resolveActor — drop-in replacement for requireAuth that also accepts
 * Bearer oc_<...> agent API keys (OpenChat-7c9).
 *
 * Auth precedence:
 *   1. Bearer <jwt>  — validated against JWT_SECRET or NOOS_JWT_SECRET
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
  keyId: string;
  keyPrefix: string;
  scopes: string[];
  expiresAt: number | null; // unix ms — null means no expiry
  cachedAt: number;         // unix ms
}

interface ResolvedAgentKey {
  userId: string;
  keyId: string;
  scopes: string[];
}

declare module 'express-serve-static-core' {
  interface Request {
    agentScopes?: string[];
  }
}

// In-memory LRU-ish cache keyed by sha256 hash of the full credential.
const KEY_CACHE = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;

export function evictFromCache(keyPrefix: string): void {
  for (const [hash, entry] of KEY_CACHE.entries()) {
    if (entry.keyPrefix === keyPrefix) {
      KEY_CACHE.delete(hash);
    }
  }
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

function hashCredential(fullKey: string): string {
  return crypto.createHash('sha256').update(fullKey).digest('hex');
}

async function resolveAgentKey(fullKey: string): Promise<ResolvedAgentKey | null> {
  // keyPrefix = "oc_" + first 8 chars after "oc_" = first 11 chars total
  const keyPrefix = fullKey.slice(0, 11);
  const keyHash = hashCredential(fullKey);

  // Check in-memory cache first using full credential hash.
  const cached = KEY_CACHE.get(keyHash);
  if (cached) {
    const age = Date.now() - cached.cachedAt;
    if (age < CACHE_TTL_MS) {
      // Still valid — check expiry
      if (cached.expiresAt !== null && Date.now() > cached.expiresAt) return null;
      return { userId: cached.userId, keyId: cached.keyId, scopes: cached.scopes };
    }
    KEY_CACHE.delete(keyHash);
  }

  const session = getDriver().session();
  try {
    const result = await session.run(
      `MATCH (k:AgentKey {keyPrefix: $keyPrefix})
       WHERE k.revokedAt IS NULL
         AND (k.expiresAt IS NULL OR k.expiresAt > $now)
       RETURN k.keyCiphertext AS keyCiphertext,
              k.keyIv AS keyIv,
              k.id AS keyId,
              k.ownerUserId AS ownerUserId,
              k.expiresAt AS expiresAt,
              k.scopes AS scopes`,
      { keyPrefix, now: new Date().toISOString() }
    );

    if (result.records.length === 0) return null;

    const record = result.records[0];
    const keyCiphertext = record.get('keyCiphertext') as string;
    const keyIv = record.get('keyIv') as string;
    const keyId = record.get('keyId') as string;
    const ownerUserId = record.get('ownerUserId') as string;
    const expiresAt = record.get('expiresAt') as string | null;
    const scopesList = record.get('scopes') as string[] | null;
    const scopes = scopesList || [];

    const plaintext = decryptKey(keyCiphertext, keyIv);
    if (!plaintext || plaintext !== fullKey) return null;

    // Cache the result by hash.
    KEY_CACHE.set(keyHash, {
      userId: ownerUserId,
      keyId,
      keyPrefix,
      scopes,
      expiresAt: expiresAt ? new Date(expiresAt).getTime() : null,
      cachedAt: Date.now(),
    });

    // Update lastUsedAt asynchronously.
    const bgSession = getDriver().session();
    bgSession
      .run(
        `MATCH (k:AgentKey {keyPrefix: $keyPrefix}) SET k.lastUsedAt = $now`,
        { keyPrefix, now: new Date().toISOString() }
      )
      .catch(() => { /* best-effort */ })
      .finally(() => bgSession.close());

    return { userId: ownerUserId, keyId, scopes };
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
    req.agentScopes = undefined;
    next();
    return;
  }

  // Agent API key path.
  if (!getEncryptionKey()) {
    res.status(503).json({ error: 'Server not configured for agent keys' });
    return;
  }

  try {
    const resolved = await resolveAgentKey(token);
    if (!resolved) {
      res.status(401).json({ error: 'Invalid, expired, or revoked agent key' });
      return;
    }
    // Synthesise an AuthUser from the key's owner so route handlers work unchanged.
    req.user = { userId: resolved.userId, email: '' };
    req.agentKeyId = resolved.keyId;
    req.agentScopes = resolved.scopes;
    next();
  } catch (err) {
    console.error('resolveActor error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
