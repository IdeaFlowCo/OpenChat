import { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { getDriver } from '../db.js';

export interface AuthUser {
  userId: string;
  email: string;
}

export type AgentKeyCapability =
  | 'read_profile'
  | 'read_chat'
  | 'write_chat'
  | 'manage_conversations'
  | 'manage_participants'
  | 'manage_presence'
  | 'manage_agent_keys';

export type AgentKeyCapabilities = Record<AgentKeyCapability, boolean>;

export const DEFAULT_AGENT_KEY_CAPABILITIES: AgentKeyCapabilities = {
  read_profile: true,
  read_chat: true,
  write_chat: true,
  manage_conversations: true,
  manage_participants: true,
  manage_presence: true,
  manage_agent_keys: true,
};

export interface AuthContext {
  source: 'jwt' | 'agent_key';
  agentKey?: {
    id: string;
    keyPrefix: string;
    capabilities: AgentKeyCapabilities;
  };
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      auth?: AuthContext;
    }
  }
}

interface CacheEntry {
  user: AuthUser;
  keyId: string;
  keyPrefix: string;
  capabilities: AgentKeyCapabilities;
  expiresAt: number | null;
  cachedAt: number;
}

const KEY_CACHE = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;

function getJwtSecret(): string {
  return process.env.JWT_SECRET || 'dev-secret-change-me';
}

function getEncryptionKey(): Buffer | null {
  const hex = process.env.OC_KEY_ENCRYPTION_SECRET;
  if (!hex || hex.length !== 64) return null;
  return Buffer.from(hex, 'hex');
}

export function decryptAgentKey(keyCiphertext: string, keyIv: string): string | null {
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

export function evictAgentKeyFromCache(keyPrefix: string): void {
  KEY_CACHE.delete(keyPrefix);
}

function coerceCapability(value: unknown): boolean {
  return typeof value === 'boolean' ? value : true;
}

export function normalizeAgentKeyCapabilities(raw: Partial<Record<AgentKeyCapability, unknown>> = {}): AgentKeyCapabilities {
  return {
    read_profile: coerceCapability(raw.read_profile),
    read_chat: coerceCapability(raw.read_chat),
    write_chat: coerceCapability(raw.write_chat),
    manage_conversations: coerceCapability(raw.manage_conversations),
    manage_participants: coerceCapability(raw.manage_participants),
    manage_presence: coerceCapability(raw.manage_presence),
    manage_agent_keys: coerceCapability(raw.manage_agent_keys),
  };
}

export function validateToken(token: string): AuthUser | null {
  try {
    const decoded = jwt.verify(token, getJwtSecret()) as AuthUser;
    return decoded;
  } catch {
    return null;
  }
}

async function resolveAgentKey(fullKey: string): Promise<CacheEntry | null> {
  const keyPrefix = fullKey.slice(0, 11);
  const cached = KEY_CACHE.get(keyPrefix);

  if (cached) {
    const age = Date.now() - cached.cachedAt;
    if (age < CACHE_TTL_MS) {
      if (cached.expiresAt !== null && Date.now() > cached.expiresAt) return null;
      return cached;
    }
    KEY_CACHE.delete(keyPrefix);
  }

  const session = getDriver().session();
  try {
    const result = await session.run(`
      MATCH (k:AgentKey {keyPrefix: $keyPrefix})
      WHERE k.revokedAt IS NULL
        AND (k.expiresAt IS NULL OR k.expiresAt > $now)
      MATCH (owner:User {id: k.ownerUserId})
      RETURN k.id AS keyId,
             k.keyPrefix AS keyPrefix,
             k.keyCiphertext AS keyCiphertext,
             k.keyIv AS keyIv,
             k.expiresAt AS expiresAt,
             owner.id AS ownerUserId,
             owner.email AS ownerEmail,
             k.capReadProfile AS capReadProfile,
             k.capReadChat AS capReadChat,
             k.capWriteChat AS capWriteChat,
             k.capManageConversations AS capManageConversations,
             k.capManageParticipants AS capManageParticipants,
             k.capManagePresence AS capManagePresence,
             k.capManageAgentKeys AS capManageAgentKeys
    `, { keyPrefix, now: new Date().toISOString() });

    if (result.records.length === 0) return null;

    const record = result.records[0];
    const plaintext = decryptAgentKey(
      record.get('keyCiphertext') as string,
      record.get('keyIv') as string
    );
    if (!plaintext || plaintext !== fullKey) return null;

    const entry: CacheEntry = {
      user: {
        userId: record.get('ownerUserId') as string,
        email: (record.get('ownerEmail') as string | null) || '',
      },
      keyId: record.get('keyId') as string,
      keyPrefix: record.get('keyPrefix') as string,
      capabilities: normalizeAgentKeyCapabilities({
        read_profile: record.get('capReadProfile') as boolean | null,
        read_chat: record.get('capReadChat') as boolean | null,
        write_chat: record.get('capWriteChat') as boolean | null,
        manage_conversations: record.get('capManageConversations') as boolean | null,
        manage_participants: record.get('capManageParticipants') as boolean | null,
        manage_presence: record.get('capManagePresence') as boolean | null,
        manage_agent_keys: record.get('capManageAgentKeys') as boolean | null,
      }),
      expiresAt: record.get('expiresAt') ? new Date(record.get('expiresAt') as string).getTime() : null,
      cachedAt: Date.now(),
    };

    KEY_CACHE.set(keyPrefix, entry);
    session.run(
      `MATCH (k:AgentKey {keyPrefix: $keyPrefix}) SET k.lastUsedAt = $now`,
      { keyPrefix, now: new Date().toISOString() }
    ).catch(() => {});

    return entry;
  } finally {
    await session.close();
  }
}

function setJwtAuth(req: Request, user: AuthUser): void {
  req.user = user;
  req.auth = { source: 'jwt' };
}

function setAgentKeyAuth(req: Request, entry: CacheEntry): void {
  req.user = entry.user;
  req.auth = {
    source: 'agent_key',
    agentKey: {
      id: entry.keyId,
      keyPrefix: entry.keyPrefix,
      capabilities: entry.capabilities,
    },
  };
}

export function requireCapability(capability?: AgentKeyCapability) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authorization header required' });
    return;
  }

  const token = authHeader.slice(7);

    if (!token.startsWith('oc_')) {
      const user = validateToken(token);
      if (!user) {
        res.status(401).json({ error: 'Invalid or expired token' });
        return;
      }
      setJwtAuth(req, user);
      next();
      return;
    }

    if (!getEncryptionKey()) {
      res.status(503).json({ error: 'Server not configured for agent keys' });
      return;
    }

    try {
      const entry = await resolveAgentKey(token);
      if (!entry) {
        res.status(401).json({ error: 'Invalid, expired, or revoked agent key' });
        return;
      }
      if (capability && !entry.capabilities[capability]) {
        res.status(403).json({ error: `Agent key is not allowed to use ${capability}` });
        return;
      }
      setAgentKeyAuth(req, entry);
      next();
    } catch (error) {
      console.error('Agent key auth error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  };
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  void requireCapability()(req, res, next);
}

export function optionalAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    next();
    return;
  }

  const token = authHeader.slice(7);

  if (!token.startsWith('oc_')) {
    const user = validateToken(token);
    if (user) {
      setJwtAuth(req, user);
    }
    next();
    return;
  }

  void resolveAgentKey(token)
    .then((entry) => {
      if (entry) setAgentKeyAuth(req, entry);
    })
    .finally(next);
}
