/**
 * The `@agent` tag (openchat-6zn): a chat message that tags it is answered, in
 * that chat, by the sender's own built-in OpenChat agent. The server decides;
 * these helpers only drive the composer hint and must match
 * `apps/server/src/services/threadAgent.ts` (`parseAgentTag`).
 */
const AGENT_TAG = /(^|[\s([{])@agent(?![\w@-])/iu;

/** True when sending this text would ask the agent. */
export function hasAgentTag(text: string): boolean {
  return AGENT_TAG.test(text);
}

/**
 * True while the person is still typing a mention that could become `@agent`
 * ("@", "@a", "@age" at the end of the text), so the composer can offer it.
 */
export function isTypingAgentTag(text: string): boolean {
  const match = text.match(/(^|[\s([{])@([a-z]*)$/i);
  if (!match) return false;
  const typed = match[2]!.toLowerCase();
  return typed.length < 'agent'.length && 'agent'.startsWith(typed);
}

/** Replace the unfinished trailing mention with the tag, or append the tag. */
export function insertAgentTag(text: string): string {
  if (hasAgentTag(text)) return text;
  if (isTypingAgentTag(text)) return text.replace(/@[a-z]*$/i, '@agent ');
  return text.trim() ? `${text.replace(/\s+$/, '')} @agent ` : '@agent ';
}
