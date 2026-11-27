import type { BeeperPublicOffer, BeeperReadConnection, BeeperReadJob } from '../api/client';

export function beeperFailure(error: unknown): string {
  let code = error instanceof Error ? error.message : '';
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') code = error.code;
  if (error && typeof error === 'object' && 'body' in error && typeof error.body === 'string') {
    try { code = JSON.parse(error.body).error; } catch { /* use the safe generic copy below */ }
  }
  const copy: Record<string, string> = {
    invalid_or_expired_offer: 'This Mac offer is invalid or expired. Create a new public offer on your Mac.',
    connection_already_bound: 'This offer is already bound. Create a new public offer on your Mac.',
    connection_revoked_or_expired: 'This connection was revoked or expired. A new approval is required.',
    connection_not_available: 'This connection is unavailable for your account.',
    chat_not_available: 'This source chat is no longer in the Mac catalogue. Refresh the catalogue.',
    too_many_pending_scans: 'Other reads are waiting for the Mac. Finish those before requesting another.',
    scan_already_started: 'This read has already started. Check its progress.',
    scan_not_available: 'This read is no longer available for your account.',
    scan_superseded: 'A newer read replaced this one. Request a new source refresh.',
    source_reconciliation_required: 'The source changed and needs reconciliation on the Mac. This copy may be partial.',
    beeper_secure_grant_required: 'Authorization required. Approve this selected chat on your paired Mac first. Secure device pairing must be enabled before a source read can run.',
    device_authorization_required: 'Authorization required on your paired device before the Mac can read this chat.',
    secure_grant_pending_review: 'Secure device authorization is not available yet. No source read has been authorized.',
    secure_device_authorization_not_ready: 'Secure device authorization is not available yet. No source read has been authorized.',
    beeper_authorization_unavailable: 'Secure device authorization is not available yet. No source read has been authorized.',
  };
  return copy[code] ?? 'Could not complete this Beeper request. Your saved copy has not been marked fresh. Try again.';
}

export function beeperConnectionState(connection: BeeperReadConnection): string {
  if (connection.state === 'revoked') return 'Revoked';
  if (!Number.isFinite(Date.parse(connection.expiresAt)) || Date.parse(connection.expiresAt) <= Date.now()) return 'Expired · approval required';
  if (connection.state !== 'active') return 'Authorization required';
  if (!connection.heartbeatAt || !Number.isFinite(Date.parse(connection.heartbeatAt)) || Date.now() - Date.parse(connection.heartbeatAt) > 120_000) return 'Waiting for Mac';
  return 'Mac connected';
}

export function beeperJobState(job: BeeperReadJob | null, authorized: boolean): string {
  if (!job) return 'Preparing source read';
  if (job.state === 'cancelled') return 'Read cancelled';
  if (job.state === 'failed') return job.chatId ? 'Partial copy · source read stopped' : 'Source read stopped';
  if (job.state === 'done') return job.completedAt ? 'Source read completed' : 'Completion not yet confirmed';
  if (!authorized) return 'Authorization required';
  if (job.nextSequence > 0 || job.lastBatchAt) return 'Partial copy received · syncing';
  return job.state === 'leased' ? 'Syncing from Mac' : 'Waiting for Mac';
}

/** Only the documented public offer is sent. Tokens, key material, local paths,
 * unknown fields and a different destination are never accepted by this UI. */
export function parsePublicBeeperOffer(text: string): BeeperPublicOffer {
  const value: unknown = JSON.parse(text);
  const fields = ['protocol', 'destination', 'connectionId', 'machineKey', 'deviceKey', 'accountKey', 'catalogueGrantId', 'relayTokenHash', 'expiresAt'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key))) throw new Error('invalid_or_expired_offer');
  const v = value as Record<string, unknown>;
  if (v.protocol !== 'openchat.beeper.read.v1' || v.destination !== 'https://chat.ideaflow.app'
    || fields.some(key => typeof v[key] !== 'string') || !Number.isFinite(Date.parse(v.expiresAt as string))
    || Date.parse(v.expiresAt as string) <= Date.now() || Date.parse(v.expiresAt as string) > Date.now() + 7 * 86400000
    || ['connectionId', 'catalogueGrantId'].some(key => !/^[a-f0-9]{48}$/.test(v[key] as string))
    || ['machineKey', 'deviceKey', 'accountKey', 'relayTokenHash'].some(key => !/^[a-f0-9]{64}$/.test(v[key] as string))) throw new Error('invalid_or_expired_offer');
  return v as unknown as BeeperPublicOffer;
}
