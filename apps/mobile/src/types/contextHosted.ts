/** Owner-only projection. Never place these drafts in shared chat state/storage. */
export interface HostedContextPreferences {
  enabled: boolean;
  available: boolean;
}
export type HostedContextStatus = 'queued' | 'processing' | 'review' | 'published' | 'declined' | 'cancelled' | 'failed' | 'expired' | 'unavailable';
export interface HostedContextRequest {
  id: string;
  conversationId: string;
  conversationTitle: string;
  postId: string;
  sourceRevision: number;
  status: HostedContextStatus;
  source: { text: string; author: { id: string; name: string } };
  audience: { id: string; name: string }[];
  expiresAt: string;
  privateInputIncluded: boolean;
  privateInputSummary?: string;
  privateText?: string;
  draft?: { id: string; text: string; approvalDigest: string; createdAt: string };
  publishedPostId?: string;
  error?: string;
}
