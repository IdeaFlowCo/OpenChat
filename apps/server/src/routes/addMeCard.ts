import { Router, Request, Response } from 'express';
import type { Server as IOServer } from 'socket.io';
import { getDriver } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import {
  getOrCreateOwnCard,
  parseCardSettingsPatch,
  resolveCardToken,
  rotateOwnCardToken,
  updateOwnCardSettings,
} from '../services/addMeCard.js';
import { DirectConversationNotAllowedError, ensureDirectConversation } from '../services/directConversation.js';
import { renderCardVcard } from '../services/addMeCardVcard.js';
import { changeFriend, FriendError, getFriendStatus } from '../services/friends.js';

/**
 * AddMe card API, mounted at /api/card. The owner-facing routes live under
 * /me; the token routes are the stranger-facing surface.
 */
const router = Router();

// No-login export. Resolve the active token on every request, using the same
// consent projection as the public page and JSON route. Never cache a card
// across rotation or field changes.
router.get('/:token/contact.vcf', async (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const session = getDriver().session();
  try {
    const resolved = await resolveCardToken(session, req.params.token as string);
    if (!resolved) {
      res.status(404).json({ error: 'Card not found' });
      return;
    }
    res.setHeader('Content-Type', 'text/vcard; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="openchat-contact.vcf"');
    res.send(renderCardVcard(resolved.card, req.params.token as string));
  } catch (error) {
    console.error('Error exporting AddMe card:', error);
    res.status(500).json({ error: 'Failed to export card' });
  } finally {
    await session.close();
  }
});

// GET /api/card/me — the caller's card, created with minimum fields on first use.
router.get('/me', requireAuth, async (req: Request, res: Response) => {
  const session = getDriver().session();
  try {
    const card = await getOrCreateOwnCard(session, req.user!.userId);
    if (!card) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json(card);
  } catch (error) {
    console.error('Error loading AddMe card:', error);
    res.status(500).json({ error: 'Failed to load card' });
  } finally {
    await session.close();
  }
});

// PATCH /api/card/me — choose which fields the card exposes.
router.patch('/me', requireAuth, async (req: Request, res: Response) => {
  const parsed = parseCardSettingsPatch(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const session = getDriver().session();
  try {
    const card = await updateOwnCardSettings(session, req.user!.userId, parsed.patch);
    if (!card) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json(card);
  } catch (error) {
    console.error('Error updating AddMe card:', error);
    res.status(500).json({ error: 'Failed to update card' });
  } finally {
    await session.close();
  }
});

// POST /api/card/me/rotate — revoke the current link/QR and mint a new one.
router.post('/me/rotate', requireAuth, async (req: Request, res: Response) => {
  const session = getDriver().session();
  try {
    const card = await rotateOwnCardToken(session, req.user!.userId);
    if (!card) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json(card);
  } catch (error) {
    console.error('Error rotating AddMe card:', error);
    res.status(500).json({ error: 'Failed to reset card link' });
  } finally {
    await session.close();
  }
});

// GET /api/card/:token — public. Exactly the stranger projection, no ids.
router.get('/:token', async (req: Request, res: Response) => {
  const session = getDriver().session();
  try {
    const resolved = await resolveCardToken(session, req.params.token as string);
    res.setHeader('Cache-Control', 'no-store');
    if (!resolved) {
      res.status(404).json({ error: 'Card not found' });
      return;
    }
    res.json(resolved.card);
  } catch (error) {
    console.error('Error resolving AddMe card:', error);
    res.status(500).json({ error: 'Failed to load card' });
  } finally {
    await session.close();
  }
});

// POST /api/card/:token/add — add the owner as a contact, i.e. open (or
// reuse) the direct conversation, which is OpenChat's contact model.
router.post('/:token/add', requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const session = getDriver().session();
  let ownerId: string;
  try {
    const resolved = await resolveCardToken(session, req.params.token as string);
    if (!resolved) {
      res.status(404).json({ error: 'Card not found' });
      return;
    }
    ownerId = resolved.ownerId;
  } catch (error) {
    console.error('Error resolving AddMe card for add:', error);
    res.status(500).json({ error: 'Failed to add contact' });
    return;
  } finally {
    await session.close();
  }

  if (ownerId === userId) {
    res.status(400).json({ error: 'This is your own card' });
    return;
  }

  try {
    const result = await ensureDirectConversation(userId, ownerId, req.app.get('io') as IOServer | undefined);
    res.status(result.created ? 201 : 200).json({
      conversationId: result.conversation.id,
      created: result.created === true,
    });
  } catch (error) {
    if (error instanceof DirectConversationNotAllowedError) {
      res.status(404).json({ error: 'Card not found' });
      return;
    }
    console.error('Error adding contact from AddMe card:', error);
    res.status(500).json({ error: 'Failed to add contact' });
  }
});

// New clients use an explicit relationship action; /add stays a legacy DM API.
router.get('/:token/friend-status', requireAuth, async (req: Request, res: Response) => {
  const session = getDriver().session();
  try {
    const resolved = await resolveCardToken(session, req.params.token as string);
    if (!resolved) { res.status(404).json({ error: 'Card not found' }); return; }
    res.json(await getFriendStatus(req.user!.userId, resolved.ownerId, true));
  } catch (error) {
    if (error instanceof FriendError) res.status(error.status).json({ error: error.message });
    else { console.error('Error loading card friend status:', error); res.status(500).json({ error: 'Failed to load friend status' }); }
  } finally { await session.close(); }
});

router.post('/:token/friend-request', requireAuth, async (req: Request, res: Response) => {
  const session = getDriver().session();
  try {
    const resolved = await resolveCardToken(session, req.params.token as string);
    if (!resolved) { res.status(404).json({ error: 'Card not found' }); return; }
    res.json(await changeFriend(req.user!.userId, resolved.ownerId, 'request', 'card', true, req.params.token as string));
  } catch (error) {
    if (error instanceof FriendError) res.status(error.status).json({ error: error.message });
    else { console.error('Error requesting friend from card:', error); res.status(500).json({ error: 'Failed to request friend' }); }
  } finally { await session.close(); }
});

export default router;
