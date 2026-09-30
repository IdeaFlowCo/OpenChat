import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export type ConnectorScope = 'openchat.read' | 'openchat.send';
export interface ConnectorClient { id: string; secret: string; callbacks: string[] }
export interface ConnectorConfig { clients: ConnectorClient[]; enabled: boolean; now?: () => number }
export interface Delegation {
  clientId: string;
  connectorGrantId: string;
  connectorUserId: string;
  openChatUserId: string;
  scopes: ConnectorScope[];
  expiresAt: number;
}
interface Pending extends Omit<Delegation, 'openChatUserId' | 'expiresAt'> {
  callback: string;
  state: string;
  challenge: string;
  expectedOpenChatUserId?: string;
  reviewedUserId?: string;
  expiresAt: number;
}
interface Code { pending: Pending; openChatUserId: string; expiresAt: number }

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const opaque = (prefix = '') => prefix + randomBytes(32).toString('base64url');
const safeEqual = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};
const validId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;
const validCallback = (v: unknown): v is string => {
  if (typeof v !== 'string') return false;
  try {
    const url = new URL(v);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
  } catch { return false; }
};

export function connectorRouteScope(method: string, path: string): ConnectorScope | null {
  if (method === 'GET' && (path === '/api/chat/conversations' || path === '/api/chat/search'
    || /^\/api\/chat\/conversations\/[^/]+\/messages$/.test(path))) return 'openchat.read';
  if (method === 'POST' && /^\/api\/chat\/conversations\/[^/]+\/messages$/.test(path)) return 'openchat.send';
  return null;
}

/** This in-process store is deliberately a disabled test harness, not a production grant database. */
export class ConnectorDelegationService {
  private readonly pending = new Map<string, Pending>();
  private readonly codes = new Map<string, Code>();
  private readonly grants = new Map<string, Delegation>();
  private readonly now: () => number;

  constructor(private readonly config: ConnectorConfig) { this.now = config.now ?? Date.now; }
  get enabled() { return this.config.enabled; }

  private prune(): void {
    const now = this.now();
    for (const [key, value] of this.pending) if (value.expiresAt <= now) this.pending.delete(key);
    for (const [key, value] of this.codes) if (value.expiresAt <= now) this.codes.delete(key);
    for (const [key, value] of this.grants) if (value.expiresAt <= now) this.grants.delete(key);
  }

  authenticateClient(clientId: string, secret: string): boolean {
    const client = this.config.clients.find((item) => item.id === clientId);
    return Boolean(this.enabled && client && safeEqual(client.secret, secret));
  }

  start(input: {
    clientId: string; callback: string; connectorGrantId: string; connectorUserId: string;
    scopes: ConnectorScope[]; state: string; codeChallenge: string; expectedOpenChatUserId?: string;
  }): string | null {
    this.prune();
    const client = this.config.clients.find((item) => item.id === input.clientId);
    if (!this.enabled || this.pending.size >= 10_000 || !client || !validCallback(input.callback)
      || !client.callbacks.includes(input.callback)
      || !validId(input.connectorGrantId) || !validId(input.connectorUserId)
      || !validId(input.state) || !/^[A-Za-z0-9_-]{43}$/.test(input.codeChallenge)
      || (input.expectedOpenChatUserId !== undefined && !validId(input.expectedOpenChatUserId))
      || !Array.isArray(input.scopes) || input.scopes.length < 1
      || input.scopes.some((s) => s !== 'openchat.read' && s !== 'openchat.send')
      || (input.scopes.includes('openchat.send') && !input.scopes.includes('openchat.read'))) return null;
    const transaction = opaque();
    this.pending.set(digest(transaction), { ...input, challenge: input.codeChallenge,
      scopes: [...new Set(input.scopes)], expiresAt: this.now() + 300_000 });
    return transaction;
  }

  review(transaction: string, openChatUserId: string): { clientId: string; connectorGrantId: string; connectorUserId: string; openChatUserId: string; scopes: ConnectorScope[] } | null {
    const pending = this.pending.get(digest(transaction));
    if (!this.enabled || !pending || pending.expiresAt <= this.now()
      || (pending.expectedOpenChatUserId && pending.expectedOpenChatUserId !== openChatUserId)
      || (pending.reviewedUserId && pending.reviewedUserId !== openChatUserId)) return null;
    pending.reviewedUserId = openChatUserId;
    return { clientId: pending.clientId, connectorGrantId: pending.connectorGrantId,
      connectorUserId: pending.connectorUserId,
      openChatUserId, scopes: [...pending.scopes] };
  }

  consent(transaction: string, openChatUserId: string, approvedScopes: ConnectorScope[]): { callback: string; code: string; state: string } | null {
    const key = digest(transaction);
    const pending = this.pending.get(key);
    this.pending.delete(key);
    if (!this.enabled || !pending || pending.expiresAt <= this.now() || !validId(openChatUserId)
      || pending.reviewedUserId !== openChatUserId
      || (pending.expectedOpenChatUserId && pending.expectedOpenChatUserId !== openChatUserId)
      || !Array.isArray(approvedScopes) || !approvedScopes.includes('openchat.read')
      || approvedScopes.some((scope) => !pending.scopes.includes(scope)) || this.codes.size >= 10_000) return null;
    const code = opaque();
    this.codes.set(digest(code), { pending: { ...pending, scopes: [...new Set(approvedScopes)] },
      openChatUserId, expiresAt: this.now() + 120_000 });
    return { callback: pending.callback, code, state: pending.state };
  }

  exchange(input: { clientId: string; callback: string; code: string; verifier: string; state: string }): { token: string; delegation: Delegation } | null {
    this.prune();
    if (![input.clientId, input.code, input.verifier, input.state].every(validId)
      || !validCallback(input.callback) || input.callback.length > 2048
      || input.verifier.length > 128) return null;
    const key = digest(input.code);
    const record = this.codes.get(key);
    this.codes.delete(key);
    if (!this.enabled || !record || record.expiresAt <= this.now() || this.grants.size >= 10_000
      || record.pending.clientId !== input.clientId || record.pending.callback !== input.callback
      || record.pending.state !== input.state || !/^[A-Za-z0-9._~-]{43,128}$/.test(input.verifier)
      || !safeEqual(createHash('sha256').update(input.verifier).digest('base64url'), record.pending.challenge)) return null;
    const token = opaque('ocd_');
    const delegation: Delegation = {
      clientId: record.pending.clientId,
      connectorGrantId: record.pending.connectorGrantId,
      connectorUserId: record.pending.connectorUserId,
      openChatUserId: record.openChatUserId,
      scopes: record.pending.scopes,
      expiresAt: this.now() + 3_600_000,
    };
    this.grants.set(digest(token), delegation);
    return { token, delegation };
  }

  authorize(token: string, method: string, path: string, expectedUserId?: string): Delegation | null {
    const grant = this.grants.get(digest(token));
    const scope = connectorRouteScope(method, path);
    if (!this.enabled || !grant || grant.expiresAt <= this.now() || !scope
      || !grant.scopes.includes(scope) || (expectedUserId && grant.openChatUserId !== expectedUserId)) return null;
    return grant;
  }

  revoke(input: { clientId: string; connectorGrantId: string; connectorUserId: string; openChatUserId: string }): number {
    if (!this.enabled) return 0;
    let count = 0;
    for (const [hash, grant] of this.grants) {
      if (grant.clientId === input.clientId && grant.connectorGrantId === input.connectorGrantId
        && grant.connectorUserId === input.connectorUserId && grant.openChatUserId === input.openChatUserId) {
        this.grants.delete(hash);
        count++;
      }
    }
    return count;
  }
}

export function loadConnectorDelegationConfig(): ConnectorConfig {
  // The in-process authorization store is a local/test fixture. Production
  // cannot be enabled by setting an environment variable on this revision.
  if (process.env.NODE_ENV === 'production' || process.env.OPENCHAT_CONNECTOR_DELEGATION_ENABLED !== 'true') {
    return { enabled: false, clients: [] };
  }
  try {
    const clients = JSON.parse(process.env.OPENCHAT_CONNECTOR_CLIENTS_JSON || '[]') as ConnectorClient[];
    if (!Array.isArray(clients) || clients.some((c) => !validId(c.id) || !validId(c.secret)
      || !Array.isArray(c.callbacks) || c.callbacks.length === 0
      || c.callbacks.some((url) => !validCallback(url)))) return { enabled: false, clients: [] };
    return { enabled: clients.length > 0, clients };
  } catch { return { enabled: false, clients: [] }; }
}
