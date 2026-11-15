export { formatListTime } from './time';

/** Show a presence dot only when someone is actually around. */
export function onlinePresence(status: string | undefined): string | undefined {
  return status === 'available' || status === 'online' || status === 'away' || status === 'busy' ? status : undefined;
}
