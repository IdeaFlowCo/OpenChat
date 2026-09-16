import { Router, type Request, type Response } from 'express';
import type { Server as IOServer } from 'socket.io';
import { resolveActor } from '../middleware/resolveActor.js';
import {
  createIntent,
  IntentConsentError,
  listIntents,
  listMatches,
  respondToMatch,
  withdrawIntent,
  type IntentKind,
  type MatchingMode,
  type MatchDecision,
} from '../services/agentNetwork.js';

const router = Router();

function parseIntentBody(body: unknown):
  | {
      kind: IntentKind;
      terms: string;
      details?: string;
      expiresAt?: string;
      goal?: string;
      seeks?: string[];
      brings?: string[];
      matchingMode?: MatchingMode;
      openToCollaborators?: boolean;
      audienceRestricted?: boolean;
      audienceUserIds?: string[];
      audienceConversationIds?: string[];
      closeOnConnect?: boolean;
      confirmed: true;
    }
  | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'Request body is required' };
  const {
    kind, terms, details, expiresAt, goal, seeks, brings, matchingMode,
    openToCollaborators, audience, closeOnConnect, confirm,
  } = body as Record<string, unknown>;
  if (confirm !== true) return { error: 'confirm:true is required after the user approves the exact discoverable terms' };
  if (kind !== 'ask' && kind !== 'offer') return { error: "kind must be 'ask' or 'offer'" };
  if (typeof terms !== 'string' || terms.trim().length < 1 || terms.trim().length > 500) {
    return { error: 'terms must be between 1 and 500 characters' };
  }
  if (details !== undefined && (typeof details !== 'string' || details.length > 2000)) {
    return { error: 'details must be a string of at most 2000 characters' };
  }
  if (expiresAt !== undefined && (
    typeof expiresAt !== 'string'
    || !Number.isFinite(Date.parse(expiresAt))
    || Date.parse(expiresAt) <= Date.now()
  )) {
    return { error: 'expiresAt must be a future ISO date-time' };
  }
  if (goal !== undefined && (typeof goal !== 'string' || goal.trim().length > 500)) {
    return { error: 'goal must be a string of at most 500 characters' };
  }
  const parseTerms = (value: unknown, field: string): string[] | { error: string } | undefined => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > 20 || value.some((item) => (
      typeof item !== 'string' || item.trim().length < 1 || item.trim().length > 500
    ))) return { error: `${field} must be an array of at most 20 non-empty strings (500 characters each)` };
    return value.map((item) => (item as string).trim());
  };
  const parsedSeeks = parseTerms(seeks, 'seeks');
  if (parsedSeeks && !Array.isArray(parsedSeeks)) return parsedSeeks;
  const parsedBrings = parseTerms(brings, 'brings');
  if (parsedBrings && !Array.isArray(parsedBrings)) return parsedBrings;
  if (matchingMode !== undefined && !['fulfillment', 'reciprocal', 'shared_goal'].includes(String(matchingMode))) {
    return { error: 'matchingMode must be fulfillment, reciprocal, or shared_goal' };
  }
  if (openToCollaborators !== undefined && typeof openToCollaborators !== 'boolean') {
    return { error: 'openToCollaborators must be boolean' };
  }
  if (closeOnConnect !== undefined && typeof closeOnConnect !== 'boolean') {
    return { error: 'closeOnConnect must be boolean' };
  }
  let audienceUserIds: string[] | undefined;
  let audienceConversationIds: string[] | undefined;
  if (audience !== undefined) {
    if (!audience || typeof audience !== 'object') return { error: 'audience must be an object' };
    const audienceRecord = audience as Record<string, unknown>;
    const validIds = (value: unknown): value is string[] => Array.isArray(value)
      && value.length <= 100
      && value.every((id) => typeof id === 'string' && id.trim().length > 0);
    if (!validIds(audienceRecord.userIds ?? []) || !validIds(audienceRecord.conversationIds ?? [])) {
      return { error: 'audience ids must be arrays of at most 100 non-empty strings' };
    }
    audienceUserIds = [...new Set(audienceRecord.userIds as string[] ?? [])];
    audienceConversationIds = [...new Set(audienceRecord.conversationIds as string[] ?? [])];
    if (audienceUserIds.length + audienceConversationIds.length === 0) {
      return { error: 'audience must select at least one user or conversation' };
    }
  }
  return {
    kind,
    terms: terms.trim(),
    confirmed: true,
    ...(details === undefined ? {} : { details }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(goal === undefined ? {} : { goal: goal.trim() }),
    ...(parsedSeeks === undefined ? {} : { seeks: parsedSeeks }),
    ...(parsedBrings === undefined ? {} : { brings: parsedBrings }),
    ...(matchingMode === undefined ? {} : { matchingMode: matchingMode as MatchingMode }),
    ...(openToCollaborators === undefined ? {} : { openToCollaborators }),
    ...(audience === undefined ? {} : {
      audienceRestricted: true,
      audienceUserIds,
      audienceConversationIds,
    }),
    ...(closeOnConnect === undefined ? {} : { closeOnConnect }),
  };
}

router.post('/intents', resolveActor, async (req: Request, res: Response) => {
  const parsed = parseIntentBody(req.body);
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  try {
    const { confirmed, ...intentInput } = parsed;
    const intent = await createIntent(req.user!.userId, intentInput, {
      confirmed,
      io: req.app.get('io') as IOServer | undefined,
    });
    res.status(201).json({ intent });
  } catch (error) {
    if (error instanceof IntentConsentError) {
      res.status(400).json({ error: error.message });
      return;
    }
    console.error('Error publishing intent:', error);
    res.status(500).json({ error: 'Failed to publish intent' });
  }
});

router.get('/intents', resolveActor, async (req: Request, res: Response) => {
  try {
    res.json({ intents: await listIntents(req.user!.userId) });
  } catch (error) {
    console.error('Error listing intents:', error);
    res.status(500).json({ error: 'Failed to list intents' });
  }
});

router.patch('/intents/:id', resolveActor, async (req: Request, res: Response) => {
  if (req.body?.status !== 'withdrawn' || Object.keys(req.body ?? {}).some((key) => key !== 'status')) {
    res.status(400).json({ error: "Only status:'withdrawn' is supported" });
    return;
  }
  try {
    const intent = await withdrawIntent(req.user!.userId, req.params.id as string);
    if (!intent) {
      res.status(404).json({ error: 'Intent not found' });
      return;
    }
    res.json({ intent });
  } catch (error) {
    console.error('Error withdrawing intent:', error);
    res.status(500).json({ error: 'Failed to withdraw intent' });
  }
});

router.get('/matches', resolveActor, async (req: Request, res: Response) => {
  try {
    res.json({
      matches: await listMatches(
        req.user!.userId,
        req.app.get('io') as IOServer | undefined,
      ),
    });
  } catch (error) {
    console.error('Error listing matches:', error);
    res.status(500).json({ error: 'Failed to list matches' });
  }
});

router.post('/matches/:id/respond', resolveActor, async (req: Request, res: Response) => {
  const decision = req.body?.decision as MatchDecision | undefined;
  if (decision !== 'approve' && decision !== 'decline') {
    res.status(400).json({ error: "decision must be 'approve' or 'decline'" });
    return;
  }
  try {
    const match = await respondToMatch(
      req.user!.userId,
      req.params.id as string,
      decision,
      req.app.get('io') as IOServer | undefined,
    );
    if (!match) {
      res.status(404).json({ error: 'Match not found' });
      return;
    }
    res.json({ match });
  } catch (error) {
    console.error('Error responding to match:', error);
    res.status(500).json({ error: 'Failed to respond to match' });
  }
});

export default router;
