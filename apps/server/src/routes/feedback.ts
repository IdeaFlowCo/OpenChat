/**
 * Feedback API (oc8.3 / openchat-aec.3) — user feedback -> WorldIssueTracker.
 *
 * POST /api/feedback { message, context? }
 *   Creates an issue on worldissuetracker.com via the WIT agent key
 *   (server env WIT_AGENT_KEY). Returns { url } to the created issue so the
 *   client can confirm + link to it.
 *
 * v1 is one-way (creates a WIT issue). Future: route feedback to an
 * OpenChat-native agent that can converse back in-app (agent-sidebar epic).
 *
 * Auth: resolveActor — works for logged-in users AND agent keys.
 */
import { Router, Request, Response } from 'express';
import { resolveActor } from '../middleware/resolveActor.js';

const router = Router();

const WIT_BASE =
  process.env.WIT_API_BASE ||
  'https://sthqnyjniclvnflfkyio.supabase.co/functions/v1';
const WIT_SITE = process.env.WIT_SITE_URL || 'https://worldissuetracker.com';
const MAX_MESSAGE = 5000;

// POST /api/feedback — create a WIT issue from a user's feedback message.
router.post('/', resolveActor, async (req: Request, res: Response) => {
  const userId = req.user?.userId;
  const { message, context } = req.body as {
    message?: string;
    context?: string;
  };

  if (!message || typeof message !== 'string' || !message.trim()) {
    res.status(400).json({ error: 'message is required' });
    return;
  }
  if (message.length > MAX_MESSAGE) {
    res.status(400).json({ error: `message too long (max ${MAX_MESSAGE})` });
    return;
  }

  const key = process.env.WIT_AGENT_KEY;
  if (!key) {
    // Fail loudly but gracefully so the client can show a useful message.
    res.status(503).json({
      error: 'Feedback is not configured on the server (WIT_AGENT_KEY missing).',
    });
    return;
  }

  const firstLine = message.trim().split('\n')[0]!.slice(0, 80);
  const title = `[OpenChat] ${firstLine || 'feedback'}`;
  const description = [
    message.trim(),
    '',
    '---',
    `Submitted via OpenChat by user ${userId ?? 'unknown'}.`,
    context ? `Context: ${context}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const r = await fetch(`${WIT_BASE}/create-issue`, {
      method: 'POST',
      headers: { 'X-Agent-Key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        description,
        labels: ['openchat-feedback'],
      }),
    });
    const data = (await r.json().catch(() => null)) as
      | { success?: boolean; issue?: { id?: string; slug?: string } }
      | null;

    if (!r.ok || !data?.success) {
      res
        .status(502)
        .json({ error: 'Failed to create feedback issue', detail: data });
      return;
    }

    const slug = data.issue?.slug;
    const url = slug ? `${WIT_SITE}/issue/${slug}` : WIT_SITE;
    res.status(201).json({ url, id: data.issue?.id });
  } catch {
    res.status(502).json({ error: 'Failed to reach feedback service' });
  }
});

export default router;
