/** Fixed host contract. The embedded inbox never reads/writes standalone auth. */
export const UNLINKED_ORIGIN = 'https://www.unlinked.ai';
export function isUnlinkedEmbed(): boolean {
  return typeof window !== 'undefined' && new URLSearchParams(window.location?.search).get('embed') === 'unlinked';
}
export function isEmbedSessionMessage(event: MessageEvent, nonce: string): boolean {
  return event.origin === UNLINKED_ORIGIN && event.source === window.parent &&
    event.data?.type === 'unlinked:session' && event.data?.nonce === nonce &&
    typeof event.data?.token === 'string' && event.data.token.length < 8192 &&
    typeof event.data?.user?.userId === 'string' && Boolean(event.data.user.userId);
}
