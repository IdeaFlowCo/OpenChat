/** Verified context stays in this account's memory. No message or persistent draft. */
export interface ProfileAskContext { id: string; text: string; expiresAt: string }
let pending: { userId: string; conversationId: string; ask: ProfileAskContext; capturedAt: number } | null = null;
let account: string | undefined;
export function setProfileAskAccount(userId: string | undefined) {
  if (account !== userId) { pending = null; account = userId; }
}
const listeners = new Set<() => void>();
export function queueProfileAskContext(userId: string, conversationId: string, ask: ProfileAskContext) {
  setProfileAskAccount(userId);
  pending = { userId, conversationId, ask, capturedAt: Date.now() }; listeners.forEach(listener => listener());
}
export function readProfileAskContext(userId: string, conversationId: string): ProfileAskContext | null {
  if (pending?.userId !== userId || pending.conversationId !== conversationId) return null;
  return Date.parse(pending.ask.expiresAt) > Date.now() && Date.now() - pending.capturedAt < 3600000 ? pending.ask : null;
}
export function onProfileAskContext(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }

export function dismissProfileAskContext(userId: string | undefined, conversationId: string) {
  if (pending?.userId === userId && pending?.conversationId === conversationId) { pending = null; listeners.forEach(listener => listener()); }
}
