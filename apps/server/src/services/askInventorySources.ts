/** Read-only federation contract. Each source retains its own writer and ACLs. */
export type AskInventorySource = 'overlay' | 'social' | 'unlinked' | 'wit' | 'gestalt';
export interface AskSourceReference { source: AskInventorySource; kind: string; id: string; revision?: string }
export interface AskInventoryProjection {
  /** Stable typed identity, never a normalized-text hash. */
  ref: AskSourceReference;
  title: string;
  lifecycle: { sourceValue: string; label: string };
  /** Only verified lineage collapses projections into one logical item. */
  canonicalAsk?: { id: string; binding: 'explicit_promotion' | 'source_receipt' };
  lineage: AskSourceReference[];
  openUrl?: string;
}
export type AskSourcePage =
  | { availability: 'available'; items: AskInventoryProjection[]; nextCursor: string | null; truncated: boolean }
  | { availability: 'unavailable'; items: []; nextCursor: null; reason: string };
export interface AskInventoryReadAdapter<VerifiedViewer> {
  readonly source: AskInventorySource;
  /** Cursor must be source/filter/viewer-bound; upstream ACL applies before pagination. */
  read(viewer: VerifiedViewer, input: { cursor?: string; limit: number; query?: string }): Promise<AskSourcePage>;
}
