/**
 * GroupBrain bot user (openchat bot-channel).
 *
 * A dedicated bot User for the groupbrain external service — DISTINCT from the
 * in-app `assistant` singleton (services/assistant.ts). groupbrain talks to
 * OpenChat over the REST + outbound-webhook surface using an agent API key that
 * is owned by (and acts as) this bot user, so its DMs and rooms are visibly its
 * own rather than sharing the `assistant` identity.
 *
 * Mirrors ensureAssistantUser(): idempotent MERGE on boot.
 */

import { getDriver } from '../db.js';

export const GROUPBRAIN_BOT_USER_ID = 'groupbrain';
export const GROUPBRAIN_BOT_NAME = 'GroupBrain';
export const GROUPBRAIN_BOT_EMAIL = 'groupbrain@openchat.local';

/**
 * Idempotently create the dedicated GroupBrain bot User. Called once on boot,
 * alongside ensureAssistantUser().
 */
export async function ensureGroupbrainBotUser(): Promise<void> {
  const s = getDriver().session();
  try {
    await s.run(
      `MERGE (u:User {id: $id})
       ON CREATE SET u.name = $name, u.email = $email, u.isBot = true,
                     u.createdAt = datetime($now)
       SET u.isBot = true, u.name = coalesce(u.name, $name), u.email = coalesce(u.email, $email)`,
      { id: GROUPBRAIN_BOT_USER_ID, name: GROUPBRAIN_BOT_NAME, email: GROUPBRAIN_BOT_EMAIL, now: new Date().toISOString() }
    );
  } finally {
    await s.close();
  }
}
