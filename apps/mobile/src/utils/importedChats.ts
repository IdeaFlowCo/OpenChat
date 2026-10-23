/**
 * Wording for imported chat mirrors (OpenChat-061g). Honest by construction:
 * a mirror says where it came from and how much of it is here, a participant
 * without a name stays unnamed, and "not linked" never claims someone is not
 * on OpenChat.
 */
import type { ImportedAskStatus, ImportedCoverage, ImportedPerson } from '../api/client';

const NETWORKS: Record<string, string> = { whatsapp: 'WhatsApp', telegram: 'Telegram', signal: 'Signal', imessage: 'iMessage', instagram: 'Instagram', messenger: 'Messenger', linkedin: 'LinkedIn' };
export const networkName = (network: string) => NETWORKS[network] ?? network.charAt(0).toUpperCase() + network.slice(1);
export const mirrorLabel = (network: string) => `${networkName(network)} mirror · read-only`;

export function shortDate(iso: string | null | undefined, withYear = true): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, withYear ? { month: 'short', day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric' });
}

export function messageTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : `${shortDate(iso)} ${date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

/** "As of Oct 20, 2026 · Oct 1 – Oct 4, 2026 · Partial history". */
export function coverageLine(coverage: ImportedCoverage): string {
  const span = coverage.earliestMessageAt && coverage.latestMessageAt
    ? `${shortDate(coverage.earliestMessageAt)} – ${shortDate(coverage.latestMessageAt)}`
    : 'No messages yet';
  return [coverage.asOf ? `As of ${shortDate(coverage.asOf)}` : null, span, coverage.complete ? 'Full history' : 'Partial history'].filter(Boolean).join(' · ');
}

export const ASK_STATUS_LABEL: Record<ImportedAskStatus, string> = { open: 'Open', resolved: 'Resolved', withdrawn: 'Withdrawn', needs_review: 'Needs review', unknown: 'Status unknown' };
export const OWNER_ASK_STATUSES = ['open', 'resolved', 'withdrawn', 'needs_review'] as const;

const NAME_SOURCE: Record<ImportedPerson['nameSource'], string> = {
  contact: 'Name from your contacts',
  push_name: 'Name they set on the network',
  profile: 'Name from their profile',
  owner: 'You',
  unknown: 'Name not known',
};
export const nameSourceLabel = (person: Pick<ImportedPerson, 'nameSource' | 'displayName'>) => person.displayName ? NAME_SOURCE[person.nameSource] : NAME_SOURCE.unknown;

/** Never says the person is not on OpenChat, only whether you linked them. */
export function accountLine(person: Pick<ImportedPerson, 'account'>): string {
  if (!person.account) return 'Not linked to an OpenChat account';
  return `Linked by you to ${person.account.name ?? 'an OpenChat account'}`;
}
