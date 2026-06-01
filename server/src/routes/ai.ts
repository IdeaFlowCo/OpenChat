import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';

// ─── Rate limiting (in-memory sliding window, v1) ────────────────────────────
const RATE_LIMIT = 60;           // requests
const RATE_WINDOW_MS = 60_000;   // 1 minute

const rateMap = new Map<string, number[]>();

function isRateLimited(userId: string): boolean {
  const now = Date.now();
  const cutoff = now - RATE_WINDOW_MS;
  let timestamps = rateMap.get(userId) ?? [];
  // Prune expired entries.
  timestamps = timestamps.filter(t => t > cutoff);
  if (timestamps.length >= RATE_LIMIT) {
    rateMap.set(userId, timestamps);
    return true;
  }
  timestamps.push(now);
  rateMap.set(userId, timestamps);
  return false;
}

// ─── Anthropic client (lazy, graceful-degradation if API key absent) ─────────
import type AnthropicType from '@anthropic-ai/sdk';
let _anthropicPromise: Promise<AnthropicType | null> | null = null;

function getAnthropicClient(): Promise<AnthropicType | null> {
  if (_anthropicPromise) return _anthropicPromise;
  _anthropicPromise = (async () => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return null;
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    return new Anthropic({ apiKey });
  })();
  return _anthropicPromise;
}

// ─── Prompts ──────────────────────────────────────────────────────────────────
type Transform = 'nvc' | 'concise' | 'formal' | 'casual' | 'translate';

function buildPrompt(transform: Transform, text: string, targetLanguage?: string): string {
  switch (transform) {
    case 'nvc':
      return `Rewrite the following message in Nonviolent Communication style — observations + feelings + needs + requests, without judgment or blame. Keep it natural and conversational, not academic. Preserve the original intent and any specifics. Return ONLY the rewritten message, no preamble or quotes.\n\n${text}`;
    case 'concise':
      return `Rewrite this message to be shorter and more direct while preserving all meaning. Return ONLY the rewritten text.\n\n${text}`;
    case 'formal':
      return `Rewrite in a formal, professional tone while preserving meaning. Return ONLY the rewritten text.\n\n${text}`;
    case 'casual':
      return `Rewrite in a casual, friendly tone while preserving meaning. Return ONLY the rewritten text.\n\n${text}`;
    case 'translate':
      return `Translate the following message to ${targetLanguage ?? 'Spanish'}. Preserve tone and meaning. Return ONLY the translated text.\n\n${text}`;
  }
}

// ─── Route ───────────────────────────────────────────────────────────────────
const router = Router();

const VALID_TRANSFORMS: Transform[] = ['nvc', 'concise', 'formal', 'casual', 'translate'];
const MAX_TEXT_LENGTH = 4000;

// POST /api/ai/transform
router.post('/transform', requireAuth, async (req: Request, res: Response) => {
  const client = await getAnthropicClient();
  if (!client) {
    res.status(503).json({ error: 'Transform feature not configured' });
    return;
  }

  const userId = req.user!.userId;

  // Rate limit check.
  if (isRateLimited(userId)) {
    res.setHeader('Retry-After', '60');
    res.status(429).json({ error: 'Rate limit exceeded. Try again in a minute.' });
    return;
  }

  const { text, transform, targetLanguage } = req.body as {
    text?: unknown;
    transform?: unknown;
    targetLanguage?: unknown;
  };

  if (typeof text !== 'string' || !text.trim()) {
    res.status(400).json({ error: 'text is required' });
    return;
  }
  if (text.length > MAX_TEXT_LENGTH) {
    res.status(400).json({ error: `text must be ${MAX_TEXT_LENGTH} characters or fewer` });
    return;
  }
  if (!transform || !VALID_TRANSFORMS.includes(transform as Transform)) {
    res.status(400).json({ error: `transform must be one of: ${VALID_TRANSFORMS.join(', ')}` });
    return;
  }
  if (transform === 'translate' && targetLanguage !== undefined && typeof targetLanguage !== 'string') {
    res.status(400).json({ error: 'targetLanguage must be a string' });
    return;
  }

  const prompt = buildPrompt(
    transform as Transform,
    text.trim(),
    typeof targetLanguage === 'string' ? targetLanguage : undefined,
  );

  try {
    const message = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });

    const block = message.content[0];
    if (!block || block.type !== 'text') {
      res.status(500).json({ error: 'Unexpected response from AI (no text block)' });
      return;
    }

    res.json({ rewritten: block.text.trim() });
  } catch (err) {
    // Surface a useful error message in the response body so the client can
    // show what actually broke. Anthropic SDK errors have .status and
    // .message; everything else falls through to err.message.
    console.error('[ai/transform] Anthropic error:', err);
    const e = err as { status?: number; message?: string; error?: { message?: string } };
    const status = typeof e.status === 'number' ? e.status : 500;
    const message = e.error?.message || e.message || 'Failed to transform message';
    res.status(status).json({ error: message });
  }
});

export default router;
