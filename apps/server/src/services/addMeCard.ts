import { Session } from 'neo4j-driver';
import { customAlphabet } from 'nanoid';
import { normalizePublicDisplayName } from '../privacy/profilePrivacy.js';

/**
 * AddMe card (OpenChat-whxy.1/.2/.3): a revocable, tokenised public card at
 * /c/:token that a stranger can scan at an event and use to add the owner.
 *
 * Consent model: the card shows the owner's display name and NOTHING else
 * unless the owner has explicitly opted a field in. The token is random and
 * unrelated to the user id, so the URL never leaks the internal id, and
 * rotating it kills every previously shared link/QR.
 *
 * Graph shape: (User)-[:HAS_ADDME_CARD]->(AddMeCard {token, revokedAt, ...}).
 * A user has at most one card with revokedAt IS NULL; rotation revokes it and
 * creates a new node that carries the same settings.
 */

// 24 chars from a 62-char alphabet ≈ 143 bits: not guessable, URL-safe, and
// alphanumeric only so it survives QR scanners and chat-app autolinkers.
const CARD_TOKEN_PATTERN = /^[0-9A-Za-z]{24}$/;
export const generateCardToken = customAlphabet(
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  24,
);

export function isWellFormedCardToken(token: unknown): token is string {
  return typeof token === 'string' && CARD_TOKEN_PATTERN.test(token);
}

export const CARD_HEADLINE_MAX = 80;
export const CARD_LINK_MAX = 200;

export type CardSettings = {
  showAvatar: boolean;
  showStatus: boolean;
  showHeadline: boolean;
  headline: string | null;
  showLinkedIn: boolean;
  linkedIn: string | null;
  showX: boolean;
  x: string | null;
  showLink: boolean;

  link: string | null;
};

/** Minimum by default: only the display name is visible. */
export const DEFAULT_CARD_SETTINGS: CardSettings = {
  showAvatar: true,
  showStatus: false,
  showHeadline: true,
  headline: null,
  showLinkedIn: true,
  linkedIn: null,
  showX: true,
  x: null,
  showLink: false,

  link: null,
};

/** Owner data as read from the graph. May contain private fields. */
export type CardOwnerRecord = {
  name?: string | null;
  avatarUrl?: string | null;
  isBot?: boolean | null;
  profileStatusText?: string | null;
  profileStatusEmoji?: string | null;
  [privateField: string]: unknown;
};

/**
 * Exactly what a stranger holding the token may see. Deliberately has no id,
 * email, presence, or discovery fields.
 */
export type StrangerCard = {
  name: string;
  isBot: boolean;
  headline: string | null;
  avatarUrl: string | null;
  status: { text: string | null; emoji: string | null } | null;
  linkedIn: string | null;
  x: string | null;

  link: string | null;
};

function nonEmpty(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * The consent projection. Pure so the matrix of "what a stranger can and
 * cannot see" is regression-tested without a database.
 */
export function projectCardForStranger(owner: CardOwnerRecord, settings: CardSettings): StrangerCard {
  const statusText = nonEmpty(owner.profileStatusText);
  const statusEmoji = nonEmpty(owner.profileStatusEmoji);
  const headline = nonEmpty(settings.headline);
  const linkedIn = nonEmpty(settings.linkedIn);
  const x = nonEmpty(settings.x);

  const link = nonEmpty(settings.link);
  return {
    name: normalizePublicDisplayName(owner.name),
    isBot: owner.isBot === true,
    headline: settings.showHeadline && headline && !headline.includes('@') ? headline : null,

    avatarUrl: settings.showAvatar ? nonEmpty(owner.avatarUrl) : null,
    status: settings.showStatus && (statusText || statusEmoji)
      ? { text: statusText, emoji: statusEmoji }
      : null,
    linkedIn: settings.showLinkedIn && linkedIn && isSafeCardLink(linkedIn) ? linkedIn : null,
    x: settings.showX && x && isSafeCardLink(x) ? x : null,
    link: settings.showLink && link && isSafeCardLink(link) ? link : null,

  };
}

export function isSafeCardLink(value: string): boolean {
  if (value.length > CARD_LINK_MAX) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
  } catch {
    return false;
  }
}

export type CardSettingsPatchResult =
  | { ok: true; patch: Partial<CardSettings> }
  | { ok: false; error: string };

/** Validate a PATCH body. Unknown keys are ignored; empty strings clear. */
export function parseCardSettingsPatch(body: unknown): CardSettingsPatchResult {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Body must be an object' };
  const input = body as Record<string, unknown>;
  const patch: Partial<CardSettings> = {};

  for (const key of ['showAvatar', 'showStatus', 'showHeadline', 'showLinkedIn', 'showX', 'showLink'] as const) {

    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'boolean') return { ok: false, error: `${key} must be a boolean` };
    patch[key] = input[key] as boolean;
  }

  for (const field of ['linkedIn', 'x'] as const) {
    if (input[field] !== undefined) {
      if (input[field] !== null && typeof input[field] !== 'string') {
        return { ok: false, error: `${field} must be a string or null` };
      }
      let url = nonEmpty(input[field]);
      if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
      if (url && !isSafeCardLink(url)) {
        return { ok: false, error: `${field} must be a valid http(s) URL` };
      }
      patch[field] = url;
    }
  }


  if (input.headline !== undefined) {
    if (input.headline !== null && typeof input.headline !== 'string') {
      return { ok: false, error: 'headline must be a string or null' };
    }
    const headline = nonEmpty(input.headline);
    if (headline && headline.length > CARD_HEADLINE_MAX) {
      return { ok: false, error: `headline must be at most ${CARD_HEADLINE_MAX} characters` };
    }
    if (headline && headline.includes('@')) {
      return { ok: false, error: 'headline must not contain an email address' };
    }
    patch.headline = headline;
  }

  if (input.link !== undefined) {
    if (input.link !== null && typeof input.link !== 'string') {
      return { ok: false, error: 'link must be a string or null' };
    }
    let link = nonEmpty(input.link);
    if (link && !/^https?:\/\//i.test(link)) link = `https://${link}`;
    if (link && !isSafeCardLink(link)) {
      return { ok: false, error: 'link must be a valid http(s) URL' };
    }
    patch.link = link;
  }

  return { ok: true, patch };
}

function settingsFromNode(props: Record<string, unknown>): CardSettings {
  return {
    showAvatar: props.showAvatar !== false, // Defaults to true if missing
    showStatus: props.showStatus === true,
    showHeadline: props.showHeadline !== false,
    headline: typeof props.headline === 'string' ? props.headline : null,
    showLinkedIn: props.showLinkedIn !== false,
    linkedIn: typeof props.linkedIn === 'string' ? props.linkedIn : null,
    showX: props.showX !== false,
    x: typeof props.x === 'string' ? props.x : null,
    showLink: props.showLink === true,

    link: typeof props.link === 'string' ? props.link : null,
  };
}

export type OwnCard = {
  token: string;
  settings: CardSettings;
  preview: StrangerCard;
};

const OWNER_FIELDS = 'u { .name, .avatarUrl, .isBot, .profileStatusText, .profileStatusEmoji }';

/**
 * Return the caller's active card, creating one with minimum settings on
 * first use. Locks the user node so concurrent first opens create one card.
 */
export async function getOrCreateOwnCard(session: Session, userId: string): Promise<OwnCard | null> {
  return session.executeWrite(async (tx) => {
    const locked = await tx.run(`
      MATCH (u:User {id: $userId})
      SET u.addMeCardCheckedAt = datetime()
      WITH u
      OPTIONAL MATCH (u)-[:HAS_ADDME_CARD]->(card:AddMeCard)
      WHERE card.revokedAt IS NULL
      RETURN ${OWNER_FIELDS} AS owner, card
      ORDER BY card.createdAt DESC
      LIMIT 1
    `, { userId });
    if (locked.records.length === 0) return null;

    const owner = locked.records[0].get('owner') as CardOwnerRecord;
    const existing = locked.records[0].get('card');
    if (existing) {
      const props = existing.properties as Record<string, unknown>;
      const settings = settingsFromNode(props);
      return { token: props.token as string, settings, preview: projectCardForStranger(owner, settings) };
    }

    const token = generateCardToken();
    await tx.run(`
      MATCH (u:User {id: $userId})
      CREATE (u)-[:HAS_ADDME_CARD]->(:AddMeCard {
        token: $token, createdAt: datetime(),
        showAvatar: true, showStatus: false, showHeadline: true, showLinkedIn: true, showX: true, showLink: false

      })
    `, { userId, token });
    return {
      token,
      settings: { ...DEFAULT_CARD_SETTINGS },
      preview: projectCardForStranger(owner, DEFAULT_CARD_SETTINGS),
    };
  });
}

export async function updateOwnCardSettings(
  session: Session,
  userId: string,
  patch: Partial<CardSettings>,
): Promise<OwnCard | null> {
  // Make sure a card exists, then apply only the keys present in the patch.
  const current = await getOrCreateOwnCard(session, userId);
  if (!current) return null;
  const next: CardSettings = { ...current.settings, ...patch };
  await session.run(`
    MATCH (:User {id: $userId})-[:HAS_ADDME_CARD]->(card:AddMeCard {token: $token})
    SET card.showAvatar = $showAvatar, card.showStatus = $showStatus,
        card.showHeadline = $showHeadline, card.showLinkedIn = $showLinkedIn,
        card.showX = $showX, card.showLink = $showLink,
        card.headline = $headline, card.linkedIn = $linkedIn, card.x = $x, card.link = $link, card.updatedAt = datetime()

  `, { userId, token: current.token, ...next });
  return getOrCreateOwnCard(session, userId);
}

/**
 * Revoke the active token and mint a new one with the same settings. Every
 * previously printed or shared QR stops resolving immediately.
 */
export async function rotateOwnCardToken(session: Session, userId: string): Promise<OwnCard | null> {
  const current = await getOrCreateOwnCard(session, userId);
  if (!current) return null;
  const token = generateCardToken();
  await session.executeWrite(tx => tx.run(`
    MATCH (u:User {id: $userId})-[:HAS_ADDME_CARD]->(old:AddMeCard)
    WHERE old.revokedAt IS NULL
    SET old.revokedAt = datetime()
    WITH u, count(old) AS revoked
    CREATE (u)-[:HAS_ADDME_CARD]->(:AddMeCard {
      token: $token, createdAt: datetime(),
      showAvatar: $showAvatar, showStatus: $showStatus, showHeadline: $showHeadline, showLinkedIn: $showLinkedIn, showX: $showX, showLink: $showLink, headline: $headline, linkedIn: $linkedIn, x: $x, link: $link

    })
  `, { userId, token, ...current.settings }));
  return getOrCreateOwnCard(session, userId);
}

export type ResolvedCard = {
  ownerId: string;
  card: StrangerCard;
};

/**
 * Resolve an active token. Returns null for malformed, unknown, or revoked
 * tokens. ownerId is for server-side use only (adding a contact) and must
 * never be sent to an unauthenticated caller.
 */
export async function resolveCardToken(session: Session, token: string): Promise<ResolvedCard | null> {
  if (!isWellFormedCardToken(token)) return null;
  const result = await session.run(`
    MATCH (u:User)-[:HAS_ADDME_CARD]->(card:AddMeCard {token: $token})
    WHERE card.revokedAt IS NULL
    RETURN u.id AS ownerId, ${OWNER_FIELDS} AS owner, card
    LIMIT 1
  `, { token });
  if (result.records.length === 0) return null;
  const record = result.records[0];
  const settings = settingsFromNode(record.get('card').properties as Record<string, unknown>);
  return {
    ownerId: record.get('ownerId') as string,
    card: projectCardForStranger(record.get('owner') as CardOwnerRecord, settings),
  };
}
