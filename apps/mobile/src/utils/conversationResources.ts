/**
 * Wording and filtering for a conversation's link resources (OpenChat-c8to.5).
 * Pure, so the filter and tag-entry rules are testable.
 */
import type { ConversationResource, ResourceKind } from '../api/client';
import { sourceNetworkName } from './unifiedTimeline';

export const KIND_LABEL: Record<ResourceKind, string> = {
  paper: 'Paper', article: 'Article', reference: 'Reference', person: 'Person', tool: 'Tool', organization: 'Organization', community: 'Community',
  code: 'Code', video: 'Video', document: 'Document', post: 'Post', event: 'Event', link: 'Link',
};

/** Every kind, in the order the editor offers them. */
export const RESOURCE_KINDS = Object.keys(KIND_LABEL) as ResourceKind[];

export type ResourceFilter = { saved: boolean; kind: ResourceKind | null; tag: string | null; query: string };
export const NO_FILTER: ResourceFilter = { saved: false, kind: null, tag: null, query: '' };

export function resourceTitle(resource: Pick<ConversationResource, 'title' | 'host' | 'url'>): string {
  return resource.title?.trim() || resource.url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '') || resource.host;
}

export function filterResources(resources: ConversationResource[], filter: ResourceFilter): ConversationResource[] {
  const query = filter.query.trim().toLowerCase().replace(/^#/, '');
  return resources.filter(resource => {
    if (filter.saved && !resource.saved) return false;
    if (filter.kind && resource.kind !== filter.kind) return false;
    if (filter.tag && !resource.tags.includes(filter.tag)) return false;
    if (!query) return true;
    return [resource.title, resource.description, resource.host, resource.url, resource.siteName, KIND_LABEL[resource.kind], ...resource.tags]
      .some(value => value?.toLowerCase().includes(query));
  });
}

/** Kinds present, most common first, for the filter row. */
export function kindCounts(resources: ConversationResource[]): Array<{ kind: ResourceKind; count: number }> {
  const counts = new Map<ResourceKind, number>();
  for (const resource of resources) counts.set(resource.kind, (counts.get(resource.kind) ?? 0) + 1);
  return [...counts].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
}

/** "ucsd, HCI research" → ["ucsd", "hci", "research"]; the server validates and normalises again. */
export function parseTagInput(input: string): string[] {
  const tags = input.split(/[\s,]+/).map(tag => tag.trim().replace(/^#+/, '').toLowerCase()).filter(Boolean);
  return [...new Set(tags)];
}

/** "Shared by Ada · Nov 9 · iMessage" — who first shared it, when and where. */
export function sharedLine(resource: Pick<ConversationResource, 'firstSharedBy' | 'firstSharedAt' | 'sources' | 'shareCount'>, viewerUserId?: string): string {
  const who = resource.firstSharedBy.userId && resource.firstSharedBy.userId === viewerUserId ? 'you' : resource.firstSharedBy.label;
  const date = resource.firstSharedAt ? new Date(resource.firstSharedAt) : null;
  const when = date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : null;
  const where = resource.sources.map(sourceNetworkName).join(' and ');
  return [who ? `Shared by ${who}` : 'Shared', when, where || null, resource.shareCount > 1 ? `${resource.shareCount} times` : null].filter(Boolean).join(' · ');
}
