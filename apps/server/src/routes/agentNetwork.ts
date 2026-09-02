import { Router, type Request, type Response } from 'express';
import type { Server as IOServer } from 'socket.io';
import { resolveActor } from '../middleware/resolveActor.js';
import {
  createIntent,
  listIntents,
  listMatches,
  respondToMatch,
  withdrawIntent,
  type IntentKind,
  type MatchDecision,
} from '../services/agentNetwork.js';

const router = Router();

function parseIntentBody(body: unknown):
  | { kind: IntentKind; terms: string; details?: string }
  | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'Request body is required' };
  const { kind, terms, details } = body as Record<string, unknown>;
  if (kind !== 'ask' && kind !== 'offer') return { error: "kind must be 'ask' or 'offer'" };
  if (typeof terms !== 'string' || terms.trim().length < 1 || terms.trim().length > 500) {
    return { error: 'terms must be between 1 and 500 characters' };
  }
  if (details !== undefined && (typeof details !== 'string' || details.length > 2000)) {
    return { error: 'details must be a string of at most 2000 characters' };
  }
  return { kind, terms: terms.trim(), ...(details === undefined ? {} : { details }) };
}

router.post('/intents', resolveActor, async (req: Request, res: Response) => {
  const parsed = parseIntentBody(req.body);
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  try {
    const intent = await createIntent(req.user!.userId, parsed, {
      io: req.app.get('io') as IOServer | undefined,
    });
    res.status(201).json({ intent });
  } catch (error) {
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
    res.json({ matches: await listMatches(req.user!.userId) });
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
