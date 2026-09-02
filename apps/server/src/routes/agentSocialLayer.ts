import { Router, type Request, type Response } from 'express';
import type { Server as IOServer } from 'socket.io';
import { resolveActor } from '../middleware/resolveActor.js';
import {
  SocialLayerValidationError,
  activateIntentDraft,
  createIntentDraft,
  createStory,
  getReviewQueue,
  getSocialPreferences,
  listIntentDrafts,
  listOwnedStories,
  listStoryFeed,
  respondToStory,
  updateIntentDraft,
  updateSocialPreferences,
  updateStory,
  type ActivationInput,
  type Audience,
  type DirectStoryInput,
  type DraftInput,
} from '../services/agentSocialLayer.js';

const router = Router();
const MODES = ['fulfillment', 'reciprocal', 'shared_goal'] as const;

function futureDate(value: unknown, field: string): string | { error: string } | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || Date.parse(value) <= Date.now()) {
    return { error: `${field} must be a future ISO date-time` };
  }
  return value;
}

function stringArray(value: unknown, field: string, optional = true): string[] | { error: string } | undefined {
  if (value === undefined && optional) return undefined;
  if (!Array.isArray(value) || value.length > 20 || value.some((item) => (
    typeof item !== 'string' || item.trim().length < 1 || item.trim().length > 500
  ))) {
    return { error: `${field} must be an array of at most 20 non-empty strings (500 characters each)` };
  }
  return [...new Set(value.map((item) => (item as string).trim()))];
}

function audience(value: unknown, required: boolean): Audience | { error: string } | undefined {
  if (value === undefined && !required) return undefined;
  if (!value || typeof value !== 'object') return { error: 'audience must be an object' };
  const record = value as Record<string, unknown>;
  const validateIds = (ids: unknown): ids is string[] => Array.isArray(ids)
    && ids.length <= 100
    && ids.every((id) => typeof id === 'string' && id.trim().length > 0);
  if (!validateIds(record.userIds ?? []) || !validateIds(record.conversationIds ?? [])) {
    return { error: 'audience ids must be arrays of at most 100 non-empty strings' };
  }
  const parsed = {
    userIds: [...new Set((record.userIds as string[] | undefined) ?? [])],
    conversationIds: [...new Set((record.conversationIds as string[] | undefined) ?? [])],
  };
  if (parsed.userIds.length + parsed.conversationIds.length === 0) {
    return { error: 'audience must select at least one user or conversation' };
  }
  return parsed;
}

function draftBody(value: unknown, partial = false): DraftInput | { error: string } {
  if (!value || typeof value !== 'object') return { error: 'Request body is required' };
  const body = value as Record<string, unknown>;
  const allowed = new Set([
    'goal', 'seeks', 'brings', 'matchingMode', 'openToCollaborators',
    'details', 'source', 'provenance', 'confidence', ...(partial ? ['state'] : []),
  ]);
  if (Object.keys(body).some((key) => !allowed.has(key))) return { error: 'Request contains unsupported fields' };
  if (body.goal !== undefined && (typeof body.goal !== 'string' || body.goal.trim().length > 500)) {
    return { error: 'goal must be a string of at most 500 characters' };
  }
  const seeks = stringArray(body.seeks, 'seeks');
  if (seeks && !Array.isArray(seeks)) return seeks;
  const brings = stringArray(body.brings, 'brings');
  if (brings && !Array.isArray(brings)) return brings;
  if (body.matchingMode !== undefined && !MODES.includes(body.matchingMode as typeof MODES[number])) {
    return { error: 'matchingMode must be fulfillment, reciprocal, or shared_goal' };
  }
  if (body.openToCollaborators !== undefined && typeof body.openToCollaborators !== 'boolean') {
    return { error: 'openToCollaborators must be boolean' };
  }
  for (const field of ['details', 'source'] as const) {
    const max = field === 'details' ? 4000 : 1000;
    if (body[field] !== undefined && (typeof body[field] !== 'string' || body[field].length > max)) {
      return { error: `${field} must be a string of at most ${max} characters` };
    }
  }
  if (body.provenance !== undefined && (
    !body.provenance || typeof body.provenance !== 'object' || Array.isArray(body.provenance)
    || JSON.stringify(body.provenance).length > 10_000
  )) return { error: 'provenance must be a JSON object of at most 10KB' };
  if (body.confidence !== undefined && (
    typeof body.confidence !== 'number' || !Number.isFinite(body.confidence)
    || body.confidence < 0 || body.confidence > 1
  )) return { error: 'confidence must be a number from 0 to 1' };
  if (partial && body.state !== undefined && body.state !== 'dismissed') {
    return { error: "state can only be set to 'dismissed'" };
  }
  const result: DraftInput & { state?: 'dismissed' } = {};
  if (body.goal !== undefined) result.goal = (body.goal as string).trim();
  if (seeks !== undefined) result.seeks = seeks;
  if (brings !== undefined) result.brings = brings;
  if (body.matchingMode !== undefined) result.matchingMode = body.matchingMode as typeof MODES[number];
  if (body.openToCollaborators !== undefined) result.openToCollaborators = body.openToCollaborators as boolean;
  if (body.details !== undefined) result.details = body.details as string;
  if (body.source !== undefined) result.source = body.source as string;
  if (body.provenance !== undefined) result.provenance = body.provenance as Record<string, unknown>;
  if (body.confidence !== undefined) result.confidence = body.confidence as number;
  if (body.state === 'dismissed') result.state = 'dismissed';
  const hasContent = (result.goal?.length ?? 0) > 0 || (result.seeks?.length ?? 0) > 0 || (result.brings?.length ?? 0) > 0;
  if (!partial && !hasContent) return { error: 'At least one non-empty goal, seek, or bring is required' };
  if (partial && Object.keys(result).length === 0) return { error: 'At least one patch field is required' };
  return result;
}

function activationBody(value: unknown): ActivationInput | { error: string } {
  if (!value || typeof value !== 'object') return { error: 'Request body is required' };
  const body = value as Record<string, unknown>;
  const result: ActivationInput = {};
  if (body.quietSearch !== undefined) {
    if (!body.quietSearch || typeof body.quietSearch !== 'object') return { error: 'quietSearch must be an object' };
    const quiet = body.quietSearch as Record<string, unknown>;
    if (typeof quiet.enabled !== 'boolean') return { error: 'quietSearch.enabled must be boolean' };
    const expiry = futureDate(quiet.expiresAt, 'quietSearch.expiresAt');
    if (expiry && typeof expiry !== 'string') return expiry;
    const parsedAudience = audience(quiet.audience, false);
    if (parsedAudience && 'error' in parsedAudience) return parsedAudience;
    result.quietSearch = {
      enabled: quiet.enabled,
      ...(expiry ? { expiresAt: expiry } : {}),
      ...(parsedAudience ? { audience: parsedAudience } : {}),
    };
  }
  if (body.story !== undefined) {
    if (!body.story || typeof body.story !== 'object') return { error: 'story must be an object' };
    const story = body.story as Record<string, unknown>;
    if (typeof story.enabled !== 'boolean') return { error: 'story.enabled must be boolean' };
    if (story.enabled && (typeof story.text !== 'string' || story.text.trim().length < 1 || story.text.trim().length > 2000)) {
      return { error: 'story.text must be between 1 and 2000 characters' };
    }
    const expiry = futureDate(story.expiresAt, 'story.expiresAt');
    if (expiry && typeof expiry !== 'string') return expiry;
    const parsedAudience = audience(story.audience, story.enabled);
    if (parsedAudience && 'error' in parsedAudience) return parsedAudience;
    result.story = {
      enabled: story.enabled,
      text: typeof story.text === 'string' ? story.text.trim() : '',
      audience: parsedAudience ?? { userIds: [], conversationIds: [] },
      ...(expiry ? { expiresAt: expiry } : {}),
    };
  }
  if (body.closeOnConnect !== undefined && typeof body.closeOnConnect !== 'boolean') {
    return { error: 'closeOnConnect must be boolean' };
  }
  if (body.closeOnConnect !== undefined) result.closeOnConnect = body.closeOnConnect;
  if (result.quietSearch?.enabled !== true && result.story?.enabled !== true) {
    return { error: 'Enable quietSearch, story, or both' };
  }
  return result;
}

function directStoryBody(value: unknown): DirectStoryInput | { error: string } {
  if (!value || typeof value !== 'object') return { error: 'Request body is required' };
  const body = value as Record<string, unknown>;
  if (typeof body.text !== 'string' || body.text.trim().length < 1 || body.text.trim().length > 2000) {
    return { error: 'text must be between 1 and 2000 characters' };
  }
  const structuredFields = {
    goal: body.goal,
    seeks: body.seeks,
    brings: body.brings,
    matchingMode: body.matchingMode,
    openToCollaborators: body.openToCollaborators,
  };
  const hasStructuredField = Object.values(structuredFields).some((item) => item !== undefined);
  const draft = hasStructuredField ? draftBody(structuredFields, true) : {};
  if ('error' in draft) return draft;
  const parsedAudience = audience(body.audience, true);
  if (!parsedAudience || 'error' in parsedAudience) return parsedAudience ?? { error: 'audience is required' };
  const storyExpiry = futureDate(body.storyExpiresAt, 'storyExpiresAt');
  if (storyExpiry && typeof storyExpiry !== 'string') return storyExpiry;
  let quietSearch: DirectStoryInput['quietSearch'];
  if (body.quietSearch !== undefined) {
    if (!body.quietSearch || typeof body.quietSearch !== 'object') return { error: 'quietSearch must be an object' };
    const quiet = body.quietSearch as Record<string, unknown>;
    if (typeof quiet.enabled !== 'boolean') return { error: 'quietSearch.enabled must be boolean' };
    const expiresAt = futureDate(quiet.expiresAt, 'quietSearch.expiresAt');
    if (expiresAt && typeof expiresAt !== 'string') return expiresAt;
    const quietAudience = audience(quiet.audience, false);
    if (quietAudience && 'error' in quietAudience) return quietAudience;
    quietSearch = {
      enabled: quiet.enabled,
      ...(expiresAt ? { expiresAt } : {}),
      ...(quietAudience ? { audience: quietAudience } : {}),
    };
  }
  if (body.closeOnConnect !== undefined && typeof body.closeOnConnect !== 'boolean') {
    return { error: 'closeOnConnect must be boolean' };
  }
  return {
    ...draft,
    text: body.text.trim(),
    audience: parsedAudience,
    ...(storyExpiry ? { storyExpiresAt: storyExpiry } : {}),
    ...(quietSearch ? { quietSearch } : {}),
    ...(body.closeOnConnect === undefined ? {} : { closeOnConnect: body.closeOnConnect }),
  };
}

function handleError(res: Response, context: string, error: unknown): void {
  if (error instanceof SocialLayerValidationError) {
    res.status(400).json({ error: error.message });
    return;
  }
  console.error(context, error);
  res.status(500).json({ error: context });
}

router.get('/intent-drafts', resolveActor, async (req: Request, res: Response) => {
  try { res.json({ drafts: await listIntentDrafts(req.user!.userId) }); }
  catch (error) { handleError(res, 'Failed to list intent drafts', error); }
});

router.post('/intent-drafts', resolveActor, async (req: Request, res: Response) => {
  const parsed = draftBody(req.body);
  if ('error' in parsed) { res.status(400).json(parsed); return; }
  try { res.status(201).json({ draft: await createIntentDraft(req.user!.userId, parsed) }); }
  catch (error) { handleError(res, 'Failed to create intent draft', error); }
});

router.patch('/intent-drafts/:id', resolveActor, async (req: Request, res: Response) => {
  const parsed = draftBody(req.body, true);
  if ('error' in parsed) { res.status(400).json(parsed); return; }
  try {
    const draft = await updateIntentDraft(req.user!.userId, req.params.id as string, parsed);
    if (!draft) { res.status(404).json({ error: 'Intent draft not found' }); return; }
    res.json({ draft });
  } catch (error) { handleError(res, 'Failed to update intent draft', error); }
});

router.post('/intent-drafts/:id/activate', resolveActor, async (req: Request, res: Response) => {
  const parsed = activationBody(req.body);
  if ('error' in parsed) { res.status(400).json(parsed); return; }
  try {
    const activated = await activateIntentDraft(req.user!.userId, req.params.id as string, parsed, {
      io: req.app.get('io') as IOServer | undefined,
    });
    if (!activated) { res.status(404).json({ error: 'Pending intent draft not found' }); return; }
    res.status(201).json(activated);
  } catch (error) { handleError(res, 'Failed to activate intent draft', error); }
});

router.get('/stories/feed', resolveActor, async (req: Request, res: Response) => {
  try { res.json({ stories: await listStoryFeed(req.user!.userId) }); }
  catch (error) { handleError(res, 'Failed to list Story feed', error); }
});

router.get('/stories/mine', resolveActor, async (req: Request, res: Response) => {
  try { res.json({ stories: await listOwnedStories(req.user!.userId) }); }
  catch (error) { handleError(res, 'Failed to list owned Stories', error); }
});

router.post('/stories', resolveActor, async (req: Request, res: Response) => {
  const parsed = directStoryBody(req.body);
  if ('error' in parsed) { res.status(400).json(parsed); return; }
  try {
    res.status(201).json(await createStory(req.user!.userId, parsed, {
      io: req.app.get('io') as IOServer | undefined,
    }));
  } catch (error) { handleError(res, 'Failed to create Story', error); }
});

router.patch('/stories/:id', resolveActor, async (req: Request, res: Response) => {
  if (!req.body || typeof req.body !== 'object') {
    res.status(400).json({ error: 'Request body is required' });
    return;
  }
  const { status, storyExpiresAt } = req.body as Record<string, unknown>;
  if (status === undefined && storyExpiresAt === undefined) {
    res.status(400).json({ error: 'Set status, storyExpiresAt, or both' }); return;
  }
  if (status !== undefined && status !== 'active' && status !== 'paused' && status !== 'withdrawn') {
    res.status(400).json({ error: 'status must be active, paused, or withdrawn' }); return;
  }
  const parsedExpiry = futureDate(storyExpiresAt, 'storyExpiresAt');
  if (parsedExpiry && typeof parsedExpiry !== 'string') { res.status(400).json(parsedExpiry); return; }
  try {
    const story = await updateStory(req.user!.userId, req.params.id as string, {
      ...(status === undefined ? {} : { status }),
      ...(parsedExpiry ? { storyExpiresAt: parsedExpiry } : {}),
    });
    if (!story) { res.status(404).json({ error: 'Story not found' }); return; }
    res.json({ story });
  } catch (error) { handleError(res, 'Failed to withdraw Story', error); }
});

router.post('/stories/:id/respond', resolveActor, async (req: Request, res: Response) => {
  if (typeof req.body?.message !== 'string' || req.body.message.trim().length < 1 || req.body.message.trim().length > 2000) {
    res.status(400).json({ error: 'message must be between 1 and 2000 characters' });
    return;
  }
  try {
    const response = await respondToStory(
      req.user!.userId,
      req.params.id as string,
      req.body.message.trim(),
      req.app.get('io') as IOServer | undefined,
    );
    if (!response) { res.status(404).json({ error: 'Visible Story not found' }); return; }
    res.status(201).json(response);
  } catch (error) { handleError(res, 'Failed to respond to Story', error); }
});

router.get('/social/preferences', resolveActor, async (req: Request, res: Response) => {
  try { res.json(await getSocialPreferences(req.user!.userId)); }
  catch (error) { handleError(res, 'Failed to load social preferences', error); }
});

router.patch('/social/preferences', resolveActor, async (req: Request, res: Response) => {
  if (!req.body || typeof req.body !== 'object') { res.status(400).json({ error: 'Request body is required' }); return; }
  const { experienceMode, networkPaused } = req.body as Record<string, unknown>;
  if (experienceMode === undefined && networkPaused === undefined) {
    res.status(400).json({ error: 'Set experienceMode, networkPaused, or both' }); return;
  }
  if (experienceMode !== undefined && experienceMode !== 'enhanced' && experienceMode !== 'simple') {
    res.status(400).json({ error: 'experienceMode must be enhanced or simple' }); return;
  }
  if (networkPaused !== undefined && typeof networkPaused !== 'boolean') {
    res.status(400).json({ error: 'networkPaused must be boolean' }); return;
  }
  try {
    res.json(await updateSocialPreferences(req.user!.userId, {
        ...(experienceMode === undefined ? {} : { experienceMode }),
        ...(networkPaused === undefined ? {} : { networkPaused }),
      }));
  } catch (error) { handleError(res, 'Failed to update social preferences', error); }
});

router.get('/review', resolveActor, async (req: Request, res: Response) => {
  try { res.json(await getReviewQueue(req.user!.userId)); }
  catch (error) { handleError(res, 'Failed to load review queue', error); }
});

export default router;
