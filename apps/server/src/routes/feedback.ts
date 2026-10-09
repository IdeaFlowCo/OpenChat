/**
 * Feedback API (oc8.3 / openchat-aec.3) — user feedback -> WorldIssueTracker.
 *
 * POST /api/feedback { message, context? }
 *   Creates an issue on worldissuetracker.com, attributed to the filer's
 *   unified Ideaflow account unless { anonymous: true } (see
 *   services/witFeedback.ts). Returns { url, id, postedAs, displayName }.
 *
 * v1 is one-way (creates a WIT issue). Future: route feedback to an
 * OpenChat-native agent that can converse back in-app (agent-sidebar epic).
 *
 * Auth: resolveActor — works for logged-in users AND agent keys.
 */
import { Router, Request, Response } from 'express';
import { resolveActor } from '../middleware/resolveActor.js';
import { FEEDBACK_MAX_MESSAGE, fileFeedback } from '../services/witFeedback.js';

const router = Router();

// POST /api/feedback — create a WIT issue from a user's feedback message.
// Filed under the filer's unified Ideaflow account unless anonymous:true.
router.post('/', resolveActor, async (req: Request, res: Response) => {
  const userId = req.user?.userId;
  const { message, context, anonymous } = req.body as {
    message?: string;
    context?: string;
    anonymous?: boolean;
  };

  if (!userId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  if (!message || typeof message !== 'string' || !message.trim()) {
    res.status(400).json({ error: 'message is required' });
    return;
  }
  if (message.length > FEEDBACK_MAX_MESSAGE) {
    res.status(400).json({ error: `message too long (max ${FEEDBACK_MAX_MESSAGE})` });
    return;
  }
  if (anonymous !== undefined && typeof anonymous !== 'boolean') {
    res.status(400).json({ error: 'anonymous must be a boolean' });
    return;
  }

  const result = await fileFeedback({
    userId,
    message,
    context: typeof context === 'string' ? context : undefined,
    anonymous: anonymous === true,
    source: req.agentScopes !== undefined ? 'agent' : 'app',
  });
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  const { ok: _ok, ...payload } = result;
  res.status(201).json(payload);
});

export default router;
