/**
 * Agent API keys.
 *
 * Keys authenticate as their owning user. Capability flags are default-on so
 * keys retain full user-session power unless a specific key is narrowed later.
 */

import { Router, Request, Response } from 'express';
import crypto from 'node:crypto';
import { nanoid } from 'nanoid';
import { getDriver } from '../db.js';
import {
  AgentKeyCapabilities,
  DEFAULT_AGENT_KEY_CAPABILITIES,
  decryptAgentKey,
  evictAgentKeyFromCache,
  normalizeAgentKeyCapabilities,
  requireCapability,
} from '../middleware/auth.js';

const router = Router();
const manageAgentKeys = requireCapability('manage_agent_keys');

function getEncryptionKey(): Buffer | null {
  const hex = process.env.OC_KEY_ENCRYPTION_SECRET;
  if (!hex || hex.length !== 64) return null;
  return Buffer.from(hex, 'hex');
}

function encryptKey(plaintext: string): { keyCiphertext: string; keyIv: string } | null {
  const encKey = getEncryptionKey();
  if (!encKey) return null;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    keyCiphertext: Buffer.concat([encrypted, tag]).toString('hex'),
    keyIv: iv.toString('hex'),
  };
}

function capabilitiesFromRequest(input: unknown): AgentKeyCapabilities {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ...DEFAULT_AGENT_KEY_CAPABILITIES };
  }
  return normalizeAgentKeyCapabilities(input as Partial<Record<keyof AgentKeyCapabilities, unknown>>);
}

function capabilitiesFromRecord(key: Record<string, unknown>): AgentKeyCapabilities {
  return normalizeAgentKeyCapabilities({
    read_profile: key.capReadProfile,
    read_chat: key.capReadChat,
    write_chat: key.capWriteChat,
    manage_conversations: key.capManageConversations,
    manage_participants: key.capManageParticipants,
    manage_presence: key.capManagePresence,
    manage_agent_keys: key.capManageAgentKeys,
  });
}

function serializeKey(key: Record<string, unknown>) {
  return {
    id: key.id,
    name: key.name,
    keyPrefix: key.keyPrefix,
    scopes: key.scopes,
    capabilities: capabilitiesFromRecord(key),
    agentName: key.agentName,
    agentVersion: key.agentVersion,
    createdAt: key.createdAt,
    lastUsedAt: key.lastUsedAt,
    expiresAt: key.expiresAt,
    revokedAt: key.revokedAt,
  };
}

router.post('/', manageAgentKeys, async (req: Request, res: Response) => {
  if (!getEncryptionKey()) {
    res.status(503).json({ error: 'Server not configured for agent keys' });
    return;
  }

  const { name, scopes, capabilities, agentName, agentVersion, expiresAt } = req.body as {
    name?: string;
    scopes?: string[];
    capabilities?: Partial<AgentKeyCapabilities>;
    agentName?: string;
    agentVersion?: string;
    expiresAt?: string;
  };

  if (!name || typeof name !== 'string' || !name.trim()) {
    res.status(400).json({ error: 'name is required' });
    return;
  }

  const plainKey = `oc_${crypto.randomBytes(24).toString('base64url')}`;
  const keyPrefix = plainKey.slice(0, 11);
  const encrypted = encryptKey(plainKey);
  if (!encrypted) {
    res.status(503).json({ error: 'Encryption failed' });
    return;
  }

  const id = nanoid();
  const createdAt = new Date().toISOString();
  const resolvedScopes = Array.isArray(scopes) && scopes.length > 0 ? scopes : ['read', 'write'];
  const resolvedCapabilities = capabilitiesFromRequest(capabilities);
  const userId = req.user!.userId;
  const session = getDriver().session();

  try {
    await session.run(`
      MATCH (u:User {id: $userId})
      CREATE (k:AgentKey {
        id: $id,
        ownerUserId: $userId,
        name: $name,
        keyPrefix: $keyPrefix,
        keyCiphertext: $keyCiphertext,
        keyIv: $keyIv,
        scopes: $scopes,
        capReadProfile: $capReadProfile,
        capReadChat: $capReadChat,
        capWriteChat: $capWriteChat,
        capManageConversations: $capManageConversations,
        capManageParticipants: $capManageParticipants,
        capManagePresence: $capManagePresence,
        capManageAgentKeys: $capManageAgentKeys,
        agentName: $agentName,
        agentVersion: $agentVersion,
        expiresAt: $expiresAt,
        createdAt: $createdAt,
        lastUsedAt: null,
        revokedAt: null
      })
      CREATE (u)-[:OWNS_KEY]->(k)
    `, {
      id,
      userId,
      name: name.trim(),
      keyPrefix,
      keyCiphertext: encrypted.keyCiphertext,
      keyIv: encrypted.keyIv,
      scopes: resolvedScopes,
      capReadProfile: resolvedCapabilities.read_profile,
      capReadChat: resolvedCapabilities.read_chat,
      capWriteChat: resolvedCapabilities.write_chat,
      capManageConversations: resolvedCapabilities.manage_conversations,
      capManageParticipants: resolvedCapabilities.manage_participants,
      capManagePresence: resolvedCapabilities.manage_presence,
      capManageAgentKeys: resolvedCapabilities.manage_agent_keys,
      agentName: agentName ?? null,
      agentVersion: agentVersion ?? null,
      expiresAt: expiresAt ?? null,
      createdAt,
    });
  } finally {
    await session.close();
  }

  res.status(201).json({
    id,
    name: name.trim(),
    keyPrefix,
    key: plainKey,
    scopes: resolvedScopes,
    capabilities: resolvedCapabilities,
    createdAt,
    expiresAt: expiresAt ?? null,
  });
});

router.get('/', manageAgentKeys, async (req: Request, res: Response) => {
  const session = getDriver().session();
  try {
    const result = await session.run(`
      MATCH (u:User {id: $userId})-[:OWNS_KEY]->(k:AgentKey)
      RETURN k {
        .id, .name, .keyPrefix, .scopes, .agentName, .agentVersion,
        .createdAt, .lastUsedAt, .expiresAt, .revokedAt,
        .capReadProfile, .capReadChat, .capWriteChat,
        .capManageConversations, .capManageParticipants, .capManagePresence,
        .capManageAgentKeys
      } AS key
      ORDER BY k.createdAt DESC
    `, { userId: req.user!.userId });

    res.json(result.records.map((r) => serializeKey(r.get('key') as Record<string, unknown>)));
  } finally {
    await session.close();
  }
});

router.get('/:id/reveal', manageAgentKeys, async (req: Request, res: Response) => {
  if (!getEncryptionKey()) {
    res.status(503).json({ error: 'Server not configured for agent keys' });
    return;
  }

  const session = getDriver().session();
  try {
    const result = await session.run(`
      MATCH (u:User {id: $userId})-[:OWNS_KEY]->(k:AgentKey {id: $id})
      RETURN k.keyCiphertext AS keyCiphertext, k.keyIv AS keyIv, k.name AS name
    `, { userId: req.user!.userId, id: req.params.id });

    if (result.records.length === 0) {
      res.status(404).json({ error: 'Key not found' });
      return;
    }

    const record = result.records[0];
    const plainKey = decryptAgentKey(
      record.get('keyCiphertext') as string,
      record.get('keyIv') as string
    );
    if (!plainKey) {
      res.status(500).json({ error: 'Failed to decrypt key' });
      return;
    }

    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
      || req.socket.remoteAddress
      || 'unknown';
    const userAgent = req.headers['user-agent'] ?? 'unknown';

    await session.run(`
      CREATE (:AgentKeyAuditLog {
        id: $auditId,
        keyId: $keyId,
        ownerUserId: $userId,
        action: 'reveal',
        at: $at,
        ip: $ip,
        userAgent: $userAgent
      })
    `, {
      auditId: nanoid(),
      keyId: req.params.id,
      userId: req.user!.userId,
      at: new Date().toISOString(),
      ip,
      userAgent,
    });

    res.json({ id: req.params.id, name: record.get('name'), key: plainKey });
  } finally {
    await session.close();
  }
});

router.patch('/:id', manageAgentKeys, async (req: Request, res: Response) => {
  const { name, scopes, capabilities } = req.body as {
    name?: string;
    scopes?: string[];
    capabilities?: Partial<AgentKeyCapabilities>;
  };

  if (name === undefined && scopes === undefined && capabilities === undefined) {
    res.status(400).json({ error: 'Provide name, scopes, and/or capabilities to update' });
    return;
  }

  const setClauses: string[] = [];
  const params: Record<string, unknown> = { userId: req.user!.userId, id: req.params.id };

  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ error: 'name must be a non-empty string' });
      return;
    }
    setClauses.push('k.name = $name');
    params.name = name.trim();
  }

  if (scopes !== undefined) {
    if (!Array.isArray(scopes)) {
      res.status(400).json({ error: 'scopes must be an array' });
      return;
    }
    setClauses.push('k.scopes = $scopes');
    params.scopes = scopes;
  }

  if (capabilities !== undefined) {
    const resolvedCapabilities = capabilitiesFromRequest(capabilities);
    setClauses.push(
      'k.capReadProfile = $capReadProfile',
      'k.capReadChat = $capReadChat',
      'k.capWriteChat = $capWriteChat',
      'k.capManageConversations = $capManageConversations',
      'k.capManageParticipants = $capManageParticipants',
      'k.capManagePresence = $capManagePresence',
      'k.capManageAgentKeys = $capManageAgentKeys'
    );
    params.capReadProfile = resolvedCapabilities.read_profile;
    params.capReadChat = resolvedCapabilities.read_chat;
    params.capWriteChat = resolvedCapabilities.write_chat;
    params.capManageConversations = resolvedCapabilities.manage_conversations;
    params.capManageParticipants = resolvedCapabilities.manage_participants;
    params.capManagePresence = resolvedCapabilities.manage_presence;
    params.capManageAgentKeys = resolvedCapabilities.manage_agent_keys;
  }

  const session = getDriver().session();
  try {
    const result = await session.run(`
      MATCH (u:User {id: $userId})-[:OWNS_KEY]->(k:AgentKey {id: $id})
      WHERE k.revokedAt IS NULL
      SET ${setClauses.join(', ')}
      RETURN k {
        .id, .name, .keyPrefix, .scopes, .agentName, .agentVersion,
        .createdAt, .lastUsedAt, .expiresAt, .revokedAt,
        .capReadProfile, .capReadChat, .capWriteChat,
        .capManageConversations, .capManageParticipants, .capManagePresence,
        .capManageAgentKeys
      } AS key
    `, params);

    if (result.records.length === 0) {
      res.status(404).json({ error: 'Key not found or already revoked' });
      return;
    }

    const key = result.records[0].get('key') as Record<string, unknown>;
    evictAgentKeyFromCache(key.keyPrefix as string);
    res.json(serializeKey(key));
  } finally {
    await session.close();
  }
});

router.delete('/:id', manageAgentKeys, async (req: Request, res: Response) => {
  const session = getDriver().session();
  try {
    const result = await session.run(`
      MATCH (u:User {id: $userId})-[:OWNS_KEY]->(k:AgentKey {id: $id})
      WHERE k.revokedAt IS NULL
      SET k.revokedAt = $now
      RETURN k.keyPrefix AS keyPrefix
    `, { userId: req.user!.userId, id: req.params.id, now: new Date().toISOString() });

    if (result.records.length === 0) {
      res.status(404).json({ error: 'Key not found or already revoked' });
      return;
    }

    evictAgentKeyFromCache(result.records[0].get('keyPrefix') as string);
    res.json({ ok: true });
  } finally {
    await session.close();
  }
});

export default router;
