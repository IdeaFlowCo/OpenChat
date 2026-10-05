import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { resolveUnlinkedRecipient, unlinkedProfileId } from '../services/unlinkedMessaging.js';

const router = Router();
const budgets = new Map<string, { at: number; count: number }>();
router.post('/unlinked/recipient', requireAuth, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const profileId = unlinkedProfileId(req.body?.profile);
  if (!profileId || Object.keys(req.body).some(key => key !== 'profile')) { res.status(400).json({ error: 'A public Unlinked profile is required.' }); return; }
  const now = Date.now();
  for (const [key, value] of budgets) if (now - value.at >= 60000) budgets.delete(key);
  const budget = budgets.get(req.user!.userId) ?? { at: now, count: 0 };
  if (budget.count >= 30 || budgets.size >= 10000 && !budgets.has(req.user!.userId)) { res.status(429).json({ error: 'Please wait a moment and try again.' }); return; }
  budget.count++; budgets.set(req.user!.userId, budget);
  try { res.json(await resolveUnlinkedRecipient(profileId)); }
  catch { res.status(503).json({ error: 'We could not open this person’s inbox. Please try again.' }); }
});
export default router;
