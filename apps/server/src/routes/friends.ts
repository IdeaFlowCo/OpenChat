import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { changeFriend, FriendError, getFriendStatus, listFriends, type FriendAction } from '../services/friends.js';

const router = Router();
router.use(requireAuth);

function fail(error: unknown, res: Response): void {
  if (error instanceof FriendError) { res.status(error.status).json({ error: error.message }); return; }
  console.error('Friend request failed:', error);
  res.status(500).json({ error: 'Friend request failed' });
}

router.get('/', async (req: Request, res: Response) => {
  try { res.json(await listFriends(req.user!.userId)); } catch (error) { fail(error, res); }
});

router.get('/users/:id', async (req: Request, res: Response) => {
  try { res.json(await getFriendStatus(req.user!.userId, req.params.id as string)); } catch (error) { fail(error, res); }
});

router.post('/users/:id/request', async (req: Request, res: Response) => {
  try { res.json(await changeFriend(req.user!.userId, req.params.id as string, 'request', 'profile')); } catch (error) { fail(error, res); }
});

for (const action of ['accept', 'decline', 'cancel', 'remove'] as FriendAction[]) {
  router.post(`/users/:id/${action}`, async (req: Request, res: Response) => {
    try { res.json(await changeFriend(req.user!.userId, req.params.id as string, action)); } catch (error) { fail(error, res); }
  });
}

export default router;
