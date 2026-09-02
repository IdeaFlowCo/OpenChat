import type { Server as IOServer } from 'socket.io';
import { nanoid } from 'nanoid';
import { getDriver } from '../db.js';
import {
  projectMatchForViewer,
  scanIntentForMatches,
  type AgentIntent,
  type AgentMatchProjection,
  type MatchIntent,
  type MatchingMode,
  type ProjectionInput,
} from './agentNetwork.js';
import { persistMessage } from './assistant.js';
import { ensureDirectConversation } from './directConversation.js';

export type DraftState = 'pending' | 'dismissed' | 'activated';
export type StoryStatus = 'active' | 'paused' | 'withdrawn';
export type ExperienceMode = 'enhanced' | 'simple';

export interface Audience {
  userIds: string[];
  conversationIds: string[];
}

export interface IntentDraft {
  id: string;
  ownerUserId: string;
  goal: string;
  seeks: string[];
  brings: string[];
  matchingMode: MatchingMode;
  openToCollaborators: boolean;
  details: string | null;
  source: string | null;
  provenance: Record<string, unknown> | null;
  confidence: number | null;
  state: DraftState;
  activatedIntentId?: string | null;
  activatedStoryId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DraftInput {
  goal?: string;
  seeks?: string[];
  brings?: string[];
  matchingMode?: MatchingMode;
  openToCollaborators?: boolean;
  details?: string | null;
  source?: string | null;
  provenance?: Record<string, unknown> | null;
  confidence?: number | null;
}

export interface ActivationInput {
  quietSearch?: { enabled: boolean; expiresAt?: string; audience?: Audience };
  story?: { enabled: boolean; text: string; expiresAt?: string; audience: Audience };
  closeOnConnect?: boolean;
}

export interface OwnedStory {
  id: string;
  ownerUserId: string;
  goal: string;
  seeks: string[];
  brings: string[];
  matchingMode: MatchingMode;
  openToCollaborators: boolean;
  text: string | null;
  humanVisible: boolean;
  agentSearchEnabled: boolean;
  explicitQuietSearch: boolean;
  status: StoryStatus;
  audience: Audience;
  storyExpiresAt: string | null;
  searchExpiresAt: string;
  intentId: string;
  createdAt: string;
  updatedAt: string;
}

export interface FeedStory {
  id: string;
  author: { id: string; name: string | null };
  goal: string;
  seeks: string[];
  brings: string[];
  matchingMode: MatchingMode;
  openToCollaborators: boolean;
  text: string;
  storyExpiresAt: string;
  createdAt: string;
}

export interface SocialPreferences {
  experienceMode: ExperienceMode;
  networkPaused: boolean;
  updatedAt: string | null;
}

export interface ReviewItem {
  id: string;
  kind: 'draft' | 'match' | 'expiring_story';
  priority: 'action' | 'soon';
  title: string;
  dueAt?: string;
  draft?: Pick<IntentDraft, 'id' | 'goal' | 'seeks' | 'brings' | 'confidence' | 'createdAt'>;
  match?: AgentMatchProjection;
  storyId?: string;
}

export interface IntentDraftCardPayload {
  version: 1;
  draft: Pick<IntentDraft, 'id' | 'goal' | 'seeks' | 'brings' | 'matchingMode' | 'openToCollaborators' | 'confidence' | 'state' | 'createdAt'>;
  visibility: { current: 'private'; humanVisible: false; agentSearchEnabled: false };
  suggestedActivation: {
    quietSearch: { enabled: true; expiresAt: string };
    closeOnConnect: true;
    audienceLabel: 'Eligible network';
  };
  actions: ['activate_quiet', 'share_story', 'keep_private', 'edit'];
}

export class SocialLayerValidationError extends Error {}

function normalizeDraftInput(input: DraftInput, requireContent: boolean): DraftInput {
  const output: DraftInput = {};
  if (Object.hasOwn(input, 'goal')) {
    if (typeof input.goal !== 'string' || input.goal.length > 500) throw new SocialLayerValidationError('Invalid goal');
    output.goal = input.goal.trim();
  }
  for (const field of ['seeks', 'brings'] as const) {
    if (!Object.hasOwn(input, field)) continue;
    const values = input[field];
    if (!Array.isArray(values) || values.length > 20 || values.some((item) => (
      typeof item !== 'string' || item.trim().length < 1 || item.trim().length > 500
    ))) throw new SocialLayerValidationError(`Invalid ${field}`);
    output[field] = [...new Set(values.map((item) => item.trim()))];
  }
  if (Object.hasOwn(input, 'matchingMode')) {
    if (!input.matchingMode || !['fulfillment', 'reciprocal', 'shared_goal'].includes(input.matchingMode)) {
      throw new SocialLayerValidationError('Invalid matching mode');
    }
    output.matchingMode = input.matchingMode;
  }
  if (Object.hasOwn(input, 'openToCollaborators')) {
    if (typeof input.openToCollaborators !== 'boolean') throw new SocialLayerValidationError('Invalid collaborator preference');
    output.openToCollaborators = input.openToCollaborators;
  }
  if (Object.hasOwn(input, 'details')) {
    if (input.details != null && (typeof input.details !== 'string' || input.details.length > 4000)) {
      throw new SocialLayerValidationError('Invalid private details');
    }
    output.details = input.details ?? null;
  }
  if (Object.hasOwn(input, 'source')) {
    if (input.source != null && (typeof input.source !== 'string' || input.source.length > 1000)) {
      throw new SocialLayerValidationError('Invalid private source');
    }
    output.source = input.source ?? null;
  }
  if (Object.hasOwn(input, 'provenance')) {
    if (input.provenance != null && (
      typeof input.provenance !== 'object' || Array.isArray(input.provenance)
      || JSON.stringify(input.provenance).length > 10_000
    )) throw new SocialLayerValidationError('Invalid provenance');
    output.provenance = input.provenance ?? null;
  }
  if (Object.hasOwn(input, 'confidence')) {
    if (input.confidence != null && (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)) {
      throw new SocialLayerValidationError('Invalid confidence');
    }
    output.confidence = input.confidence ?? null;
  }
  if (requireContent) {
    const hasContent = (output.goal?.length ?? 0) > 0
      || (output.seeks?.length ?? 0) > 0
      || (output.brings?.length ?? 0) > 0;
    if (!hasContent) throw new SocialLayerValidationError('At least one non-empty goal, seek, or bring is required');
  }
  return output;
}

function toJS(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'object' && 'toNumber' in value) {
    return (value as { toNumber: () => number }).toNumber();
  }
  if (typeof value === 'object' && 'toString' in value && 'year' in value) {
    return (value as { toString: () => string }).toString();
  }
  if (Array.isArray(value)) return value.map(toJS);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toJS(item)]));
  }
  return value;
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function draftFromRecord(value: unknown): IntentDraft {
  const draft = toJS(value) as Omit<IntentDraft, 'provenance'> & { provenanceJson?: string | null };
  return {
    ...draft,
    goal: draft.goal ?? '',
    seeks: draft.seeks ?? [],
    brings: draft.brings ?? [],
    matchingMode: draft.matchingMode ?? 'fulfillment',
    openToCollaborators: draft.openToCollaborators === true,
    details: draft.details ?? null,
    source: draft.source ?? null,
    confidence: draft.confidence ?? null,
    provenance: parseJsonObject(draft.provenanceJson),
  };
}

function ownedStoryFromRecord(value: unknown): OwnedStory {
  const story = toJS(value) as Record<string, unknown>;
  return {
    id: story.id as string,
    ownerUserId: story.ownerUserId as string,
    goal: story.goal as string ?? '',
    seeks: story.seeks as string[] ?? [],
    brings: story.brings as string[] ?? [],
    matchingMode: story.matchingMode as MatchingMode ?? 'fulfillment',
    openToCollaborators: story.openToCollaborators === true,
    text: story.text as string | null ?? null,
    humanVisible: story.humanVisible === true,
    agentSearchEnabled: story.agentSearchEnabled === true,
    explicitQuietSearch: story.explicitQuietSearch === true,
    status: story.status as StoryStatus,
    audience: {
      userIds: story.audienceUserIds as string[] ?? [],
      conversationIds: story.audienceConversationIds as string[] ?? [],
    },
    storyExpiresAt: story.storyExpiresAt as string | null ?? null,
    searchExpiresAt: story.searchExpiresAt as string,
    intentId: story.intentId as string,
    createdAt: story.createdAt as string,
    updatedAt: story.updatedAt as string,
  };
}

export function defaultStoryExpiry(now = new Date()): string {
  return new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
}

export function defaultSearchExpiry(now = new Date()): string {
  return new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
}

export function projectIntentDraftCard(draft: IntentDraft): IntentDraftCardPayload {
  return {
    version: 1,
    draft: {
      id: draft.id,
      goal: draft.goal,
      seeks: draft.seeks,
      brings: draft.brings,
      matchingMode: draft.matchingMode,
      openToCollaborators: draft.openToCollaborators,
      confidence: draft.confidence,
      state: draft.state,
      createdAt: draft.createdAt,
    },
    visibility: { current: 'private', humanVisible: false, agentSearchEnabled: false },
    suggestedActivation: {
      quietSearch: { enabled: true, expiresAt: defaultSearchExpiry(new Date(draft.createdAt)) },
      closeOnConnect: true,
      audienceLabel: 'Eligible network',
    },
    actions: ['activate_quiet', 'share_story', 'keep_private', 'edit'],
  };
}

export function projectStoryForFeed(
  story: OwnedStory,
  author: { id: string; name?: string | null },
): FeedStory {
  if (!story.humanVisible || !story.text || !story.storyExpiresAt) {
    throw new SocialLayerValidationError('Story is not human-visible');
  }
  return {
    id: story.id,
    author: { id: author.id, name: author.name ?? null },
    goal: story.goal,
    seeks: story.seeks,
    brings: story.brings,
    matchingMode: story.matchingMode,
    openToCollaborators: story.openToCollaborators,
    text: story.text,
    storyExpiresAt: story.storyExpiresAt,
    createdAt: story.createdAt,
  };
}

export async function ensureAgentSocialLayerIndexes(): Promise<void> {
  const session = getDriver().session();
  try {
    await session.run('CREATE CONSTRAINT intent_draft_id IF NOT EXISTS FOR (draft:AgentIntentDraft) REQUIRE draft.id IS UNIQUE');
    await session.run('CREATE CONSTRAINT openchat_story_id IF NOT EXISTS FOR (story:OpenChatStory) REQUIRE story.id IS UNIQUE');
    await session.run('CREATE CONSTRAINT social_preference_user IF NOT EXISTS FOR (pref:OpenChatSocialPreference) REQUIRE pref.userId IS UNIQUE');
    await session.run('CREATE INDEX intent_draft_owner IF NOT EXISTS FOR (draft:AgentIntentDraft) ON (draft.ownerUserId)');
    await session.run('CREATE INDEX openchat_story_owner IF NOT EXISTS FOR (story:OpenChatStory) ON (story.ownerUserId)');
    await session.run('CREATE INDEX openchat_story_status IF NOT EXISTS FOR (story:OpenChatStory) ON (story.status)');
  } finally {
    await session.close();
  }
}

export async function createIntentDraft(userId: string, input: DraftInput): Promise<IntentDraft> {
  input = normalizeDraftInput(input, true);
  const id = nanoid();
  const now = new Date().toISOString();
  const session = getDriver().session();
  try {
    const result = await session.run(
      `MATCH (owner:User {id: $userId})
       CREATE (draft:AgentIntentDraft {
         id: $id, ownerUserId: $userId, goal: $goal, seeks: $seeks, brings: $brings,
         matchingMode: $matchingMode, openToCollaborators: $openToCollaborators,
         details: $details, source: $source, provenanceJson: $provenanceJson,
         confidence: $confidence, state: 'pending',
         createdAt: datetime($now), updatedAt: datetime($now)
       })
       CREATE (owner)-[:OWNS_INTENT_DRAFT]->(draft)
       RETURN draft { .* } AS draft`,
      {
        id,
        userId,
        goal: input.goal ?? '',
        seeks: input.seeks ?? [],
        brings: input.brings ?? [],
        matchingMode: input.matchingMode ?? 'fulfillment',
        openToCollaborators: input.openToCollaborators ?? false,
        details: input.details ?? null,
        source: input.source ?? null,
        provenanceJson: input.provenance == null ? null : JSON.stringify(input.provenance),
        confidence: input.confidence ?? null,
        now,
      },
    );
    if (result.records.length === 0) throw new Error('Draft owner not found');
    return draftFromRecord(result.records[0].get('draft'));
  } finally {
    await session.close();
  }
}

export async function listIntentDrafts(userId: string): Promise<IntentDraft[]> {
  const session = getDriver().session();
  try {
    const result = await session.run(
      `MATCH (:User {id: $userId})-[:OWNS_INTENT_DRAFT]->(draft:AgentIntentDraft)
       RETURN draft { .* } AS draft ORDER BY draft.createdAt DESC`,
      { userId },
    );
    return result.records.map((record) => draftFromRecord(record.get('draft')));
  } finally {
    await session.close();
  }
}

export async function updateIntentDraft(
  userId: string,
  draftId: string,
  patch: DraftInput & { state?: 'dismissed' },
): Promise<IntentDraft | null> {
  const state = patch.state;
  patch = { ...normalizeDraftInput(patch, false), ...(state ? { state } : {}) };
  const keys = ['goal', 'seeks', 'brings', 'matchingMode', 'openToCollaborators', 'details', 'source', 'provenance', 'confidence'] as const;
  const present = Object.fromEntries(keys.map((key) => [`has_${key}`, Object.hasOwn(patch, key)]));
  const session = getDriver().session();
  try {
    const result = await session.run(
      `MATCH (:User {id: $userId})-[:OWNS_INTENT_DRAFT]->(draft:AgentIntentDraft {id: $draftId, state: 'pending'})
       WITH draft,
            CASE WHEN $has_goal THEN $goal ELSE draft.goal END AS nextGoal,
            CASE WHEN $has_seeks THEN $seeks ELSE draft.seeks END AS nextSeeks,
            CASE WHEN $has_brings THEN $brings ELSE draft.brings END AS nextBrings
       WHERE trim(coalesce(nextGoal, '')) <> '' OR size(coalesce(nextSeeks, [])) > 0 OR size(coalesce(nextBrings, [])) > 0
       SET draft.goal = nextGoal,
           draft.seeks = nextSeeks,
           draft.brings = nextBrings,
           draft.matchingMode = CASE WHEN $has_matchingMode THEN $matchingMode ELSE draft.matchingMode END,
           draft.openToCollaborators = CASE WHEN $has_openToCollaborators THEN $openToCollaborators ELSE draft.openToCollaborators END,
           draft.details = CASE WHEN $has_details THEN $details ELSE draft.details END,
           draft.source = CASE WHEN $has_source THEN $source ELSE draft.source END,
           draft.provenanceJson = CASE WHEN $has_provenance THEN $provenanceJson ELSE draft.provenanceJson END,
           draft.confidence = CASE WHEN $has_confidence THEN $confidence ELSE draft.confidence END,
           draft.state = CASE WHEN $dismissed THEN 'dismissed' ELSE draft.state END,
           draft.updatedAt = datetime($now)
       RETURN draft { .* } AS draft`,
      {
        userId,
        draftId,
        ...present,
        goal: patch.goal ?? '',
        seeks: patch.seeks ?? [],
        brings: patch.brings ?? [],
        matchingMode: patch.matchingMode ?? 'fulfillment',
        openToCollaborators: patch.openToCollaborators ?? false,
        details: patch.details ?? null,
        source: patch.source ?? null,
        provenanceJson: patch.provenance == null ? null : JSON.stringify(patch.provenance),
        confidence: patch.confidence ?? null,
        dismissed: patch.state === 'dismissed',
        now: new Date().toISOString(),
      },
    );
    return result.records.length ? draftFromRecord(result.records[0].get('draft')) : null;
  } finally {
    await session.close();
  }
}

async function validateAudienceOwner(userId: string, audience: Audience): Promise<void> {
  const session = getDriver().session();
  try {
    const result = await session.run(
      `MATCH (owner:User {id: $userId})
       OPTIONAL MATCH (audienceUser:User) WHERE audienceUser.id IN $userIds
       WITH owner, collect(DISTINCT audienceUser.id) AS validUserIds
       OPTIONAL MATCH (owner)-[:PARTICIPATES_IN]->(conversation:Conversation)
       WHERE conversation.id IN $conversationIds
       RETURN size(validUserIds) AS userCount,
              count(DISTINCT conversation) AS conversationCount`,
      { userId, userIds: audience.userIds, conversationIds: audience.conversationIds },
    );
    if (result.records.length === 0
      || Number(toJS(result.records[0].get('userCount'))) !== audience.userIds.length
      || Number(toJS(result.records[0].get('conversationCount'))) !== audience.conversationIds.length) {
      throw new SocialLayerValidationError('Audience contains an unknown user or a conversation the owner does not participate in');
    }
  } finally {
    await session.close();
  }
}

function intentSummary(goal: string, seeks: string[], brings: string[]): string {
  if (goal) return goal;
  if (seeks.length && brings.length) return `Seeking ${seeks.join(', ')}; bringing ${brings.join(', ')}`;
  if (seeks.length) return seeks.join(', ');
  return brings.join(', ');
}

function intentKind(seeks: string[]): 'ask' | 'offer' {
  return seeks.length > 0 ? 'ask' : 'offer';
}

function assertAudienceSelected(value: Audience, label: string): void {
  if (value.userIds.length + value.conversationIds.length === 0) {
    throw new SocialLayerValidationError(`${label} must select at least one user or conversation`);
  }
}

function assertFutureDate(value: string | undefined, label: string): void {
  if (value !== undefined && (!Number.isFinite(Date.parse(value)) || Date.parse(value) <= Date.now())) {
    throw new SocialLayerValidationError(`${label} must be a future ISO date-time`);
  }
}

interface StoryCreationValues {
  goal: string;
  seeks: string[];
  brings: string[];
  matchingMode: MatchingMode;
  openToCollaborators: boolean;
  details: string | null;
  storyText: string | null;
  storyAudience: Audience;
  searchAudience: Audience | null;
  humanVisible: boolean;
  explicitQuietSearch: boolean;
  storyExpiresAt: string | null;
  searchExpiresAt: string;
  closeOnConnect: boolean;
}

function creationValuesFromActivation(draft: IntentDraft, input: ActivationInput): StoryCreationValues {
  const quietEnabled = input.quietSearch?.enabled === true;
  const storyEnabled = input.story?.enabled === true;
  const now = new Date();
  const storyAudience = storyEnabled ? input.story!.audience : { userIds: [], conversationIds: [] };
  const searchAudience = quietEnabled
    ? input.quietSearch?.audience ?? null
    : null;
  const storyExpiresAt = storyEnabled ? input.story!.expiresAt ?? defaultStoryExpiry(now) : null;
  return {
    goal: draft.goal,
    seeks: draft.seeks,
    brings: draft.brings,
    matchingMode: draft.matchingMode,
    openToCollaborators: draft.openToCollaborators,
    details: draft.details,
    storyText: storyEnabled ? input.story!.text.trim() : null,
    storyAudience,
    searchAudience,
    humanVisible: storyEnabled,
    explicitQuietSearch: quietEnabled,
    storyExpiresAt,
    searchExpiresAt: quietEnabled
      ? input.quietSearch?.expiresAt ?? defaultSearchExpiry(now)
      : storyExpiresAt!,
    closeOnConnect: input.closeOnConnect ?? true,
  };
}

export async function activateIntentDraft(
  userId: string,
  draftId: string,
  input: ActivationInput,
  options: { io?: IOServer; queueScan?: boolean } = {},
): Promise<{ draft: IntentDraft; story: OwnedStory; intent: AgentIntent } | null> {
  if (input.quietSearch?.enabled !== true && input.story?.enabled !== true) {
    throw new SocialLayerValidationError('Enable quietSearch, story, or both');
  }
  assertFutureDate(input.quietSearch?.expiresAt, 'quietSearch.expiresAt');
  assertFutureDate(input.story?.expiresAt, 'story.expiresAt');
  if (input.story?.enabled) {
    if (!input.story.text.trim() || input.story.text.length > 2000) {
      throw new SocialLayerValidationError('Story text must be between 1 and 2000 characters');
    }
    assertAudienceSelected(input.story.audience, 'Story audience');
  }
  if (input.quietSearch?.audience) assertAudienceSelected(input.quietSearch.audience, 'Search audience');
  const drafts = await listIntentDrafts(userId);
  const draft = drafts.find((candidate) => candidate.id === draftId && candidate.state === 'pending');
  if (!draft) return null;
  const values = creationValuesFromActivation(draft, input);
  if (values.humanVisible) await validateAudienceOwner(userId, values.storyAudience);
  if (values.searchAudience) await validateAudienceOwner(userId, values.searchAudience);

  const storyId = nanoid();
  const intentId = nanoid();
  const now = new Date().toISOString();
  const searchAudience = values.searchAudience ?? { userIds: [], conversationIds: [] };
  const session = getDriver().session();
  try {
    const result = await session.run(
      `MATCH (owner:User {id: $userId})-[:OWNS_INTENT_DRAFT]->(draft:AgentIntentDraft {id: $draftId, state: 'pending'})
       WHERE trim(coalesce(draft.goal, '')) <> '' OR size(coalesce(draft.seeks, [])) > 0 OR size(coalesce(draft.brings, [])) > 0
       CREATE (intent:AgentIntent {
         id: $intentId, ownerUserId: $userId, kind: $kind, terms: $terms,
         details: $details, status: $intentStatus, expiresAt: datetime($searchExpiresAt),
         goal: $goal, seeks: $seeks, brings: $brings, matchingMode: $matchingMode,
         openToCollaborators: $openToCollaborators,
         audienceRestricted: $audienceRestricted,
         audienceUserIds: $searchAudienceUserIds,
         audienceConversationIds: $searchAudienceConversationIds,
         sourceStoryId: $storyId, closeOnConnect: $closeOnConnect,
         createdAt: datetime($now), updatedAt: datetime($now)
       })
       CREATE (story:OpenChatStory {
         id: $storyId, ownerUserId: $userId, intentId: $intentId,
         goal: $goal, seeks: $seeks, brings: $brings, matchingMode: $matchingMode,
         openToCollaborators: $openToCollaborators, text: $storyText,
         humanVisible: $humanVisible, agentSearchEnabled: $agentSearchEnabled,
         explicitQuietSearch: $explicitQuietSearch, status: 'active',
         audienceUserIds: $storyAudienceUserIds,
         audienceConversationIds: $storyAudienceConversationIds,
         storyExpiresAt: CASE WHEN $storyExpiresAt IS NULL THEN null ELSE datetime($storyExpiresAt) END,
         searchExpiresAt: datetime($searchExpiresAt),
         createdAt: datetime($now), updatedAt: datetime($now)
       })
       CREATE (owner)-[:OWNS_INTENT]->(intent)
       CREATE (owner)-[:OWNS_STORY]->(story)
       CREATE (story)-[:ACTIVATES]->(intent)
       SET draft.state = 'activated', draft.activatedIntentId = $intentId,
           draft.activatedStoryId = $storyId, draft.updatedAt = datetime($now)
       RETURN draft { .* } AS draft, story { .* } AS story, intent { .* } AS intent`,
      {
        userId,
        draftId,
        storyId,
        intentId,
        kind: intentKind(values.seeks),
        terms: intentSummary(values.goal, values.seeks, values.brings),
        details: values.details,
        intentStatus: values.explicitQuietSearch ? 'active' : 'paused',
        goal: values.goal,
        seeks: values.seeks,
        brings: values.brings,
        matchingMode: values.matchingMode,
        openToCollaborators: values.openToCollaborators,
        audienceRestricted: values.searchAudience !== null,
        searchAudienceUserIds: searchAudience.userIds,
        searchAudienceConversationIds: searchAudience.conversationIds,
        storyAudienceUserIds: values.storyAudience.userIds,
        storyAudienceConversationIds: values.storyAudience.conversationIds,
        storyText: values.storyText,
        humanVisible: values.humanVisible,
        agentSearchEnabled: values.explicitQuietSearch,
        explicitQuietSearch: values.explicitQuietSearch,
        storyExpiresAt: values.storyExpiresAt,
        searchExpiresAt: values.searchExpiresAt,
        closeOnConnect: values.closeOnConnect,
        now,
      },
    );
    if (result.records.length === 0) return null;
    const activated = {
      draft: draftFromRecord(result.records[0].get('draft')),
      story: ownedStoryFromRecord(result.records[0].get('story')),
      intent: toJS(result.records[0].get('intent')) as AgentIntent,
    };
    if (values.explicitQuietSearch && options.queueScan !== false) {
      queueMicrotask(() => void scanIntentForMatches(intentId, { io: options.io })
        .catch((error) => console.warn('[agent-social] quiet scan failed:', error)));
    }
    return activated;
  } finally {
    await session.close();
  }
}

export interface DirectStoryInput {
  goal?: string;
  seeks?: string[];
  brings?: string[];
  matchingMode?: MatchingMode;
  openToCollaborators?: boolean;
  text: string;
  audience: Audience;
  storyExpiresAt?: string;
  quietSearch?: { enabled: boolean; expiresAt?: string; audience?: Audience };
  closeOnConnect?: boolean;
}

export async function createStory(
  userId: string,
  input: DirectStoryInput,
  options: { io?: IOServer; queueScan?: boolean } = {},
): Promise<{ story: OwnedStory; intent: AgentIntent }> {
  if (!input.text.trim() || input.text.length > 2000) {
    throw new SocialLayerValidationError('Story text must be between 1 and 2000 characters');
  }
  const storyText = input.text.trim();
  assertAudienceSelected(input.audience, 'Story audience');
  assertFutureDate(input.storyExpiresAt, 'storyExpiresAt');
  assertFutureDate(input.quietSearch?.expiresAt, 'quietSearch.expiresAt');
  if (input.quietSearch?.audience) assertAudienceSelected(input.quietSearch.audience, 'Search audience');
  const canonical = normalizeDraftInput({
    ...(input.goal === undefined ? {} : { goal: input.goal }),
    ...(input.seeks === undefined ? {} : { seeks: input.seeks }),
    ...(input.brings === undefined ? {} : { brings: input.brings }),
    ...(input.matchingMode === undefined ? {} : { matchingMode: input.matchingMode }),
    ...(input.openToCollaborators === undefined ? {} : { openToCollaborators: input.openToCollaborators }),
  }, false);
  await validateAudienceOwner(userId, input.audience);
  if (input.quietSearch?.audience) await validateAudienceOwner(userId, input.quietSearch.audience);
  const storyId = nanoid();
  const intentId = nanoid();
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const goal = canonical.goal ?? '';
  const seeks = canonical.seeks ?? [];
  const brings = canonical.brings ?? [];
  const quietSearchEnabled = input.quietSearch?.enabled === true;
  const searchAudience = quietSearchEnabled
    ? input.quietSearch?.audience ?? null
    : null;
  const searchAudienceValues = searchAudience ?? { userIds: [], conversationIds: [] };
  const storyExpiresAt = input.storyExpiresAt ?? defaultStoryExpiry(nowDate);
  const searchExpiresAt = quietSearchEnabled
    ? input.quietSearch?.expiresAt ?? defaultSearchExpiry(nowDate)
    : storyExpiresAt;
  const session = getDriver().session();
  try {
    const result = await session.run(
      `MATCH (owner:User {id: $userId})
       CREATE (intent:AgentIntent {
         id: $intentId, ownerUserId: $userId, kind: $kind, terms: $terms,
         details: null, status: $intentStatus, expiresAt: datetime($searchExpiresAt),
         goal: $goal, seeks: $seeks, brings: $brings, matchingMode: $matchingMode,
         openToCollaborators: $openToCollaborators,
         audienceRestricted: $audienceRestricted,
         audienceUserIds: $searchAudienceUserIds,
         audienceConversationIds: $searchAudienceConversationIds,
         sourceStoryId: $storyId, closeOnConnect: $closeOnConnect,
         createdAt: datetime($now), updatedAt: datetime($now)
       })
       CREATE (story:OpenChatStory {
         id: $storyId, ownerUserId: $userId, intentId: $intentId,
         goal: $goal, seeks: $seeks, brings: $brings, matchingMode: $matchingMode,
         openToCollaborators: $openToCollaborators, text: $text,
         humanVisible: true, agentSearchEnabled: $agentSearchEnabled,
         explicitQuietSearch: $explicitQuietSearch, status: 'active',
         audienceUserIds: $storyAudienceUserIds,
         audienceConversationIds: $storyAudienceConversationIds,
         storyExpiresAt: datetime($storyExpiresAt), searchExpiresAt: datetime($searchExpiresAt),
         createdAt: datetime($now), updatedAt: datetime($now)
       })
       CREATE (owner)-[:OWNS_INTENT]->(intent)
       CREATE (owner)-[:OWNS_STORY]->(story)
       CREATE (story)-[:ACTIVATES]->(intent)
       RETURN story { .* } AS story, intent { .* } AS intent`,
      {
        userId,
        storyId,
        intentId,
        kind: intentKind(seeks),
        terms: intentSummary(goal, seeks, brings) || storyText,
        goal,
        seeks,
        brings,
        matchingMode: canonical.matchingMode ?? 'fulfillment',
        openToCollaborators: canonical.openToCollaborators ?? false,
        intentStatus: quietSearchEnabled ? 'active' : 'paused',
        audienceRestricted: searchAudience !== null,
        searchAudienceUserIds: searchAudienceValues.userIds,
        searchAudienceConversationIds: searchAudienceValues.conversationIds,
        storyAudienceUserIds: input.audience.userIds,
        storyAudienceConversationIds: input.audience.conversationIds,
        text: storyText,
        agentSearchEnabled: quietSearchEnabled,
        explicitQuietSearch: quietSearchEnabled,
        storyExpiresAt,
        searchExpiresAt,
        closeOnConnect: input.closeOnConnect ?? true,
        now,
      },
    );
    if (result.records.length === 0) throw new Error('Story owner not found');
    const created = {
      story: ownedStoryFromRecord(result.records[0].get('story')),
      intent: toJS(result.records[0].get('intent')) as AgentIntent,
    };
    if (quietSearchEnabled && options.queueScan !== false) {
      queueMicrotask(() => void scanIntentForMatches(intentId, { io: options.io })
        .catch((error) => console.warn('[agent-social] quiet scan failed:', error)));
    }
    return created;
  } finally {
    await session.close();
  }
}

export async function listOwnedStories(userId: string): Promise<OwnedStory[]> {
  const session = getDriver().session();
  try {
    const result = await session.run(
      `MATCH (:User {id: $userId})-[:OWNS_STORY]->(story:OpenChatStory)
       RETURN story { .* } AS story ORDER BY story.createdAt DESC`,
      { userId },
    );
    return result.records.map((record) => ownedStoryFromRecord(record.get('story')));
  } finally {
    await session.close();
  }
}

const FEED_STORY_QUERY = `
  MATCH (owner:User)-[:OWNS_STORY]->(story:OpenChatStory {status: 'active', humanVisible: true})
  MATCH (viewer:User {id: $viewerId})
  WHERE story.storyExpiresAt > datetime($now)
    AND NOT (owner)-[:BLOCKED]->(viewer)
    AND NOT (viewer)-[:BLOCKED]->(owner)
    AND (
      owner.id = viewer.id
      OR viewer.id IN coalesce(story.audienceUserIds, [])
      OR EXISTS {
        MATCH (owner)-[:PARTICIPATES_IN]->(audienceConversation:Conversation)<-[:PARTICIPATES_IN]-(viewer)
        WHERE audienceConversation.id IN coalesce(story.audienceConversationIds, [])
      }
    )
    AND ($storyId IS NULL OR story.id = $storyId)
  RETURN story { .* } AS story, owner { .id, .name } AS author
  ORDER BY story.createdAt DESC
`;

export async function listStoryFeed(userId: string): Promise<FeedStory[]> {
  const session = getDriver().session();
  try {
    const result = await session.run(FEED_STORY_QUERY, {
      viewerId: userId,
      storyId: null,
      now: new Date().toISOString(),
    });
    return result.records.map((record) => projectStoryForFeed(
      ownedStoryFromRecord(record.get('story')),
      toJS(record.get('author')) as { id: string; name?: string | null },
    ));
  } finally {
    await session.close();
  }
}

export async function updateStory(
  userId: string,
  storyId: string,
  patch: { status?: StoryStatus; storyExpiresAt?: string },
): Promise<OwnedStory | null> {
  const session = getDriver().session();
  try {
    const result = await session.run(
      `MATCH (:User {id: $userId})-[:OWNS_STORY]->(story:OpenChatStory {id: $storyId})-[:ACTIVATES]->(intent:AgentIntent)
       WITH story, intent,
            coalesce($status, story.status) AS nextStatus,
            CASE WHEN $storyExpiresAt IS NULL THEN story.storyExpiresAt ELSE datetime($storyExpiresAt) END AS nextStoryExpiry
       WHERE NOT (story.status = 'withdrawn' AND nextStatus <> 'withdrawn')
         AND (nextStatus <> 'active' OR story.humanVisible = false OR nextStoryExpiry > datetime($now))
       SET story.status = nextStatus,
           story.storyExpiresAt = nextStoryExpiry,
           story.updatedAt = datetime($now),
           intent.status = CASE
             WHEN intent.status = 'connected' THEN intent.status
             WHEN story.agentSearchEnabled = false AND nextStatus = 'withdrawn' THEN 'withdrawn'
             WHEN story.agentSearchEnabled = false THEN intent.status
             WHEN story.humanVisible = true AND story.explicitQuietSearch = true THEN intent.status
             WHEN nextStatus = 'active' AND (
               (story.humanVisible = true AND story.explicitQuietSearch = false AND nextStoryExpiry > datetime($now))
               OR ((story.humanVisible = false OR story.explicitQuietSearch = true) AND intent.expiresAt > datetime($now))
             ) THEN 'active'
             WHEN nextStatus = 'paused' THEN 'paused'
             ELSE 'withdrawn'
           END,
           intent.expiresAt = CASE
             WHEN story.agentSearchEnabled = true AND story.humanVisible = true AND story.explicitQuietSearch = false THEN nextStoryExpiry
             ELSE intent.expiresAt
           END,
           intent.updatedAt = datetime($now)
       RETURN story { .* } AS story`,
      {
        userId,
        storyId,
        status: patch.status ?? null,
        storyExpiresAt: patch.storyExpiresAt ?? null,
        now: new Date().toISOString(),
      },
    );
    return result.records.length ? ownedStoryFromRecord(result.records[0].get('story')) : null;
  } finally {
    await session.close();
  }
}

export async function withdrawStory(userId: string, storyId: string): Promise<OwnedStory | null> {
  return updateStory(userId, storyId, { status: 'withdrawn' });
}

export async function respondToStory(
  userId: string,
  storyId: string,
  message: string,
  io?: IOServer,
): Promise<{ conversationId: string; message: Record<string, unknown> } | null> {
  const session = getDriver().session();
  let ownerId: string | null = null;
  try {
    const result = await session.run(FEED_STORY_QUERY, {
      viewerId: userId,
      storyId,
      now: new Date().toISOString(),
    });
    if (result.records.length === 0) return null;
    const author = toJS(result.records[0].get('author')) as { id: string };
    ownerId = author.id;
    if (ownerId === userId) return null;
  } finally {
    await session.close();
  }
  const direct = await ensureDirectConversation(userId, ownerId, io);
  const conversationId = direct.conversation.id as string;
  const persisted = await persistMessage(io, userId, conversationId, message, {
    messageType: 'card',
    cardKind: 'story_response',
    cardPayload: JSON.stringify({ storyId }),
  });
  return persisted ? { conversationId, message: persisted.message } : null;
}

export async function getSocialPreferences(userId: string): Promise<SocialPreferences> {
  const session = getDriver().session();
  try {
    const result = await session.run(
      `MATCH (owner:User {id: $userId})
       OPTIONAL MATCH (owner)-[:HAS_SOCIAL_PREFERENCE]->(pref:OpenChatSocialPreference)
       RETURN coalesce(pref.experienceMode, 'enhanced') AS experienceMode,
              coalesce(pref.networkPaused, false) AS networkPaused,
              pref.updatedAt AS updatedAt`,
      { userId },
    );
    if (result.records.length === 0) throw new Error('Preference owner not found');
    return {
      experienceMode: result.records[0].get('experienceMode') as ExperienceMode,
      networkPaused: result.records[0].get('networkPaused') === true,
      updatedAt: result.records[0].get('updatedAt') == null
        ? null
        : String(toJS(result.records[0].get('updatedAt'))),
    };
  } finally {
    await session.close();
  }
}

export async function updateSocialPreferences(
  userId: string,
  patch: Partial<Pick<SocialPreferences, 'experienceMode' | 'networkPaused'>>,
): Promise<SocialPreferences> {
  const session = getDriver().session();
  try {
    const result = await session.run(
      `MATCH (owner:User {id: $userId})
       MERGE (pref:OpenChatSocialPreference {userId: $userId})
       ON CREATE SET pref.experienceMode = 'enhanced', pref.networkPaused = false,
                     pref.createdAt = datetime($now)
       SET pref.experienceMode = CASE WHEN $hasExperienceMode THEN $experienceMode ELSE pref.experienceMode END,
           pref.networkPaused = CASE WHEN $hasNetworkPaused THEN $networkPaused ELSE pref.networkPaused END,
           pref.updatedAt = datetime($now)
       MERGE (owner)-[:HAS_SOCIAL_PREFERENCE]->(pref)
       RETURN pref.experienceMode AS experienceMode, pref.networkPaused AS networkPaused,
              pref.updatedAt AS updatedAt`,
      {
        userId,
        hasExperienceMode: patch.experienceMode !== undefined,
        experienceMode: patch.experienceMode ?? 'enhanced',
        hasNetworkPaused: patch.networkPaused !== undefined,
        networkPaused: patch.networkPaused ?? false,
        now: new Date().toISOString(),
      },
    );
    if (result.records.length === 0) throw new Error('Preference owner not found');
    return {
      experienceMode: result.records[0].get('experienceMode') as ExperienceMode,
      networkPaused: result.records[0].get('networkPaused') === true,
      updatedAt: String(toJS(result.records[0].get('updatedAt'))),
    };
  } finally {
    await session.close();
  }
}

function projectionFromReviewRecord(record: { get: (key: string) => unknown }): AgentMatchProjection {
  return projectMatchForViewer({
    id: record.get('id') as string,
    matchStatus: record.get('matchStatus') as ProjectionInput['matchStatus'],
    ownResponse: (record.get('ownResponse') as ProjectionInput['ownResponse']) ?? null,
    ownIntent: toJS(record.get('ownIntent')) as MatchIntent,
    otherIntent: toJS(record.get('otherIntent')) as MatchIntent,
    createdAt: String(toJS(record.get('createdAt'))),
    updatedAt: String(toJS(record.get('updatedAt'))),
    conversationId: (record.get('conversationId') as string | null) ?? null,
    matchType: (record.get('matchType') as ProjectionInput['matchType']) ?? null,
    score: (toJS(record.get('score')) as number | null) ?? null,
  });
}

export async function getReviewQueue(userId: string): Promise<{ items: ReviewItem[]; hasMore: boolean }> {
  const session = getDriver().session();
  try {
    const draftResult = await session.run(
        `MATCH (:User {id: $userId})-[:OWNS_INTENT_DRAFT]->(draft:AgentIntentDraft {state: 'pending'})
         RETURN draft { .id, .goal, .seeks, .brings, .confidence, .createdAt } AS draft
         ORDER BY draft.createdAt DESC LIMIT 26`,
        { userId },
      );
    const matchResult = await session.run(
        `MATCH (:User {id: $userId})-[:OWNS_INTENT]->(own:AgentIntent)<-[:MATCHES]-(match:AgentMatch {status: 'proposed'})-[:MATCHES]->(other:AgentIntent)
         WHERE own <> other
         WITH DISTINCT match, own, other,
              CASE WHEN own.id < other.id THEN match.aResponse ELSE match.bResponse END AS ownResponse
         WHERE ownResponse IS NULL
         RETURN match.id AS id, match.status AS matchStatus, ownResponse,
                own { .id, .kind, .terms, .goal, .seeks, .brings, .matchingMode } AS ownIntent,
                other { .id, .kind, .terms, .goal, .seeks, .brings, .matchingMode } AS otherIntent,
                match.createdAt AS createdAt, match.updatedAt AS updatedAt,
                match.conversationId AS conversationId, match.matchType AS matchType,
                match.score AS score
         ORDER BY match.createdAt DESC LIMIT 26`,
        { userId },
      );
    const expiryResult = await session.run(
        `MATCH (:User {id: $userId})-[:OWNS_STORY]->(story:OpenChatStory {status: 'active'})
         WHERE story.humanVisible = true
           AND story.storyExpiresAt > datetime($now)
           AND story.storyExpiresAt <= datetime($soon)
         RETURN story.id AS storyId, story.goal AS goal,
                story.storyExpiresAt AS storyExpiresAt
         ORDER BY story.storyExpiresAt ASC LIMIT 26`,
        {
          userId,
          now: new Date().toISOString(),
          soon: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
        },
      );
    const items: ReviewItem[] = [];
    for (const record of draftResult.records) {
      const draft = toJS(record.get('draft')) as ReviewItem['draft'];
      if (!draft) continue;
      items.push({
        id: `draft:${draft.id}`,
        kind: 'draft',
        priority: 'action',
        title: draft.goal || draft.seeks[0] || draft.brings[0] || 'Review captured ask or offer',
        draft,
      });
    }
    for (const record of matchResult.records) {
      const match = projectionFromReviewRecord(record);
      items.push({
        id: `match:${match.id}`,
        kind: 'match',
        priority: 'action',
        title: 'Review a possible match',
        match,
      });
    }
    for (const record of expiryResult.records) {
      const storyId = record.get('storyId') as string;
      const goal = record.get('goal') as string | null;
      const storyExpiry = record.get('storyExpiresAt') == null
        ? null
        : String(toJS(record.get('storyExpiresAt')));
      if (storyExpiry && Date.parse(storyExpiry) <= Date.now() + 72 * 60 * 60 * 1000) {
        items.push({
          id: `expiring_story:${storyId}`,
          kind: 'expiring_story',
          priority: 'soon',
          title: goal ? `Story expiring: ${goal}` : 'Story expiring soon',
          dueAt: storyExpiry,
          storyId,
        });
      }
    }
    const hasMore = draftResult.records.length > 25
      || matchResult.records.length > 25
      || expiryResult.records.length > 25
      || items.length > 50;
    return { items: items.slice(0, 50), hasMore };
  } finally {
    await session.close();
  }
}
