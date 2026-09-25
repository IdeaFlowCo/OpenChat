import { Router, Request, Response } from 'express';
import { getDriver } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { savePendingEntry, listPendingEntries, completePendingEntry, dismissPendingEntry } from '../services/entryIntents.js';
import { resolveInvitePreview } from '../services/inviteEntry.js';
import { resolvePublicPersonProjection } from '../services/publicEntryProjection.js';
import { isWellFormedCardToken, resolveCardToken } from '../services/addMeCard.js';

const router = Router();

router.post('/entry-intents', requireAuth, async (req: Request, res: Response) => {
  const session = getDriver().session();
  const userId = req.user!.userId;
  const { clientIntentId, target, continuation } = req.body;

  if (!clientIntentId || !target || !continuation) {
    res.status(400).json({ error: 'Missing required fields' });
    return;
  }
  if (target.kind === 'card' && !isWellFormedCardToken(target.token)) {
    res.status(400).json({ error: 'Invalid card token' });
    return;
  }

  try {
    const { id } = await savePendingEntry(session, userId, clientIntentId, target, continuation);
    res.json({ id });
  } catch (error) {
    console.error('Error saving entry intent:', error);
    res.status(500).json({ error: 'Failed to save entry intent' });
  } finally {
    await session.close();
  }
});

router.get('/entry-intents', requireAuth, async (req: Request, res: Response) => {
  const session = getDriver().session();
  const userId = req.user!.userId;

  try {
    const entries = await listPendingEntries(session, userId);
    
    // Resolve limited previews
    const resolvedEntries = await Promise.all(entries.map(async (e) => {
      let preview = null;
      let available = true;
      try {
        if (e.target.kind === 'group') {
          preview = await resolveInvitePreview(session, e.target.token);
        } else if (e.target.kind === 'person') {
          preview = await resolvePublicPersonProjection(session, e.target.userId);
          if (!preview) available = false;
        } else if (e.target.kind === 'card') {
          // Stranger projection only; never the owner's id.
          preview = (await resolveCardToken(session, e.target.token))?.card ?? null;
          if (!preview) available = false;
        }
      } catch (err) {
        available = false;
      }
      return { ...e, preview, available };
    }));

    res.json(resolvedEntries);
  } catch (error) {
    console.error('Error listing entry intents:', error);
    res.status(500).json({ error: 'Failed to list entry intents' });
  } finally {
    await session.close();
  }
});

router.post('/entry-intents/:id/complete', requireAuth, async (req: Request, res: Response) => {
  const session = getDriver().session();
  const userId = req.user!.userId;
  const id = req.params.id as string;

  try {
    await completePendingEntry(session, userId, id);
    res.json({ ok: true });
  } catch (error) {
    console.error('Error completing entry intent:', error);
    res.status(500).json({ error: 'Failed to complete entry intent' });
  } finally {
    await session.close();
  }
});

router.delete('/entry-intents/:id', requireAuth, async (req: Request, res: Response) => {
  const session = getDriver().session();
  const userId = req.user!.userId;
  const id = req.params.id as string;

  try {
    await dismissPendingEntry(session, userId, id);
    res.json({ ok: true });
  } catch (error) {
    console.error('Error dismissing entry intent:', error);
    res.status(500).json({ error: 'Failed to dismiss entry intent' });
  } finally {
    await session.close();
  }
});

export default router;