export const NEW_CHAT_ORIGIN = 'https://chat.ideaflow.app';
export const LEGACY_CHAT_ORIGIN = 'https://chat.globalbr.ai';

/** New links can be held on the old host until DNS and OAuth are ready. */
export function publicChatOrigin(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPENCHAT_URL?.replace(/\/+$/, '') || NEW_CHAT_ORIGIN;
}

/** Resolve only the two public hosts; never reflect arbitrary Host headers. */
export function chatOriginForHost(host: string | undefined): string | null {
  const hostname = host?.split(':')[0]?.toLowerCase();
  if (hostname === 'chat.ideaflow.app') return NEW_CHAT_ORIGIN;
  if (hostname === 'chat.globalbr.ai') return LEGACY_CHAT_ORIGIN;
  return null;
}

/** OAuth callbacks must return to the exact browser origin that began login. */
export function ideaflowCallbackForHost(host: string | undefined): string | null {
  const origin = chatOriginForHost(host);
  return origin ? `${origin}/auth/ideaflow/callback` : null;
}
