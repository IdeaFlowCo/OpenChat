import { Router, type Request, type Response } from 'express';
import type { Server } from 'socket.io';
import { requireAuth, requireDirectSession } from '../middleware/auth.js';
import { CommunityError, listCommunities, createCommunity, getCommunity, updateCommunity,
  addCommunityGroup, unlinkCommunityGroup, joinCommunityGroup, setCommunityRole,
  removeCommunityMember, createCommunityInvite, revokeCommunityInvites, joinCommunity } from '../services/communities.js';

const router = Router();
// Community administration intentionally requires a direct signed-in person.
// oc_ keys, connector delegates and embedded Unlinked sessions get no new powers.
router.use(requireAuth,requireDirectSession,(_req,res,next) => { res.set('Cache-Control','no-store'); next(); });
function route(action: (req: Request, io?: Server) => Promise<unknown>, status = 200) {
  return async (req: Request,res: Response) => {
    try { res.status(status).json((await action(req,req.app.get('io') as Server | undefined)) ?? {ok:true}); }
    catch (error) {
      if (error instanceof CommunityError) { res.status(error.status).json({error:error.message}); return; }
      console.error('Community request failed:',error);
      res.status(500).json({error:'Could not update the community. Try again.'});
    }
  };
}
const uid = (req: Request) => req.user!.userId;
const id = (req: Request) => req.params.id as string;
router.get('/',route(req => listCommunities(uid(req))));
router.post('/',route((req,io) => createCommunity(uid(req),req.body ?? {},io),201));
router.post('/join',route((req,io) => joinCommunity(uid(req),req.body?.token,io)));
router.get('/:id',route(req => getCommunity(uid(req),id(req))));
router.patch('/:id',route((req,io) => updateCommunity(uid(req),id(req),req.body ?? {},io)));
router.post('/:id/groups',route((req,io) => addCommunityGroup(uid(req),id(req),req.body ?? {},false,io),201));
router.post('/:id/groups/link',route((req,io) => addCommunityGroup(uid(req),id(req),req.body ?? {},true,io),201));
router.delete('/:id/groups/:conversationId',route((req,io) => unlinkCommunityGroup(uid(req),id(req),req.params.conversationId as string,io)));
router.post('/:id/groups/:conversationId/join',route((req,io) => joinCommunityGroup(uid(req),id(req),req.params.conversationId as string,io)));
router.patch('/:id/members/:userId',route((req,io) => setCommunityRole(uid(req),id(req),req.params.userId as string,req.body?.role,io)));
router.delete('/:id/members/:userId',route((req,io) => removeCommunityMember(uid(req),id(req),req.params.userId as string,io)));
router.post('/:id/invites',route((req,io) => createCommunityInvite(uid(req),id(req),io),201));
router.delete('/:id/invites',route((req,io) => revokeCommunityInvites(uid(req),id(req),io)));
export default router;
