import { Router, type Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { clearPrivateName, getContactProfile, getPrivateName, PrivateNameError, setPrivateName } from '../services/privateNames.js';

const router = Router();
router.use(requireAuth);
router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

function fail(error: unknown, res: Response) {
  if (error instanceof PrivateNameError) { res.status(error.status).json({ error: error.message }); return; }
  // Do not log alias text from an error or failed query.
  console.error('Private name request failed');
  res.status(500).json({ error: 'Private name request failed' });
}
router.get('/:id/profile', async (req, res) => {
  try { res.json(await getContactProfile(req.user!.userId, req.params.id as string)); } catch (error) { fail(error, res); }
});
router.get('/:id', async (req, res) => {
  try { res.json(await getPrivateName(req.user!.userId, req.params.id as string)); } catch (error) { fail(error, res); }
});
router.put('/:id', async (req, res) => {
  try { res.json(await setPrivateName(req.user!.userId, req.params.id as string, req.body?.name)); } catch (error) { fail(error, res); }
});
router.delete('/:id', async (req, res) => {
  try { res.json(await clearPrivateName(req.user!.userId, req.params.id as string)); } catch (error) { fail(error, res); }
});
export default router;
