import { Router, Request, Response, NextFunction } from 'express';
import { getDriver } from '../db.js';
import { getConnectorPrincipal } from '../lib/ideaflowConnector.js';
import { resolveActor } from '../middleware/resolveActor.js';
import { isContextLaneEnabled } from '../config/features.js';
import {
  createContextPost,
  updateContextPost,
  deleteContextPost,
  listContextPosts,
  reportContextPost,
  ContextLaneError
} from '../services/contextLane.js';

import { contextAgentPreference, askContextAgents, listContextAgentRequests, respondToContextAgentRequest } from '../services/contextAgentRequests.js';

const router = Router();

function requireFeatureFlag(req: Request, res: Response, next: NextFunction) {
  if (!isContextLaneEnabled()) {
    res.status(404).json({ error: 'Context Lane feature is not enabled' });
    return;
  }
  next();
}

// All context routes use the feature flag and actor resolution
router.use('/conversations/:conversationId/context', requireFeatureFlag, resolveActor);
router.use('/context-agent', requireFeatureFlag, resolveActor);

router.get('/conversations/:conversationId/context', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const conversationId = String(req.params.conversationId);
  const { cursor, limit, kind, search } = req.query;
  if ([cursor, limit, kind, search].some(value => value !== undefined && typeof value !== 'string') ||
      (limit !== undefined && !/^\d+$/.test(limit as string))) {
    res.status(400).json({ error: 'cursor, limit, kind, and search must be single string values; limit must be a positive integer' });
    return;
  }

  const session = getDriver().session();
  try {
    const result = await listContextPosts(
      session,
      userId,
      conversationId,
      {
        cursor: cursor as string,
        limit: limit ? parseInt(limit as string, 10) : undefined,
        kind: kind as string,
        search: search as string,
      },
      req.agentKeyId,
      req.agentScopes
    );
    res.json(result);
  } catch (error: any) {
    if (error instanceof ContextLaneError) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      console.error('Error listing context posts:', error);
      res.status(500).json({ error: 'Failed to list context posts' });
    }
  } finally {
    await session.close();
  }
});

router.post('/conversations/:conversationId/context', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const conversationId = String(req.params.conversationId);
  const { text, kind, clientRequestId, replyToId } = req.body ?? {};

  if (typeof clientRequestId !== 'string' || !clientRequestId.trim()) {
    res.status(400).json({ error: 'clientRequestId is required' });
    return;
  }

  if (typeof text !== 'string' || !text.trim()) {
    res.status(400).json({ error: 'text must be a non-empty string (use text, not content, for context posts)' });
    return;
  }
  if ((kind !== undefined && !['note', 'ask', 'offer'].includes(kind)) ||
      (replyToId !== undefined && (typeof replyToId !== 'string' || !replyToId.trim()))) {
    res.status(400).json({ error: 'kind must be note, ask, or offer; replyToId must be a non-empty string' });
    return;
  }

  const session = getDriver().session();
  try {
    const result = await createContextPost(
      session,
      userId,
      conversationId,
      { text, kind, clientRequestId, replyToId },
      req.agentKeyId,
      req.agentScopes,
      getConnectorPrincipal(req) ? { id: 'ideaflow-connector', name: 'Ideaflow connector' } : undefined
    );
    res.status(201).json(result);
  } catch (error: any) {
    if (error instanceof ContextLaneError) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      console.error('Error creating context post:', error);
      res.status(500).json({ error: 'Failed to create context post' });
    }
  } finally {
    await session.close();
  }
});

router.patch('/conversations/:conversationId/context/:postId', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const conversationId = String(req.params.conversationId);
  const postId = String(req.params.postId);
  const { text, expectedRevision } = req.body ?? {};

  if (expectedRevision === undefined) {
    res.status(400).json({ error: 'expectedRevision is required' });
    return;
  }

  const session = getDriver().session();
  try {
    const result = await updateContextPost(
      session,
      userId,
      conversationId,
      postId,
      text,
      expectedRevision,
      req.agentKeyId,
      req.agentScopes
    );
    res.json(result);
  } catch (error: any) {
    if (error instanceof ContextLaneError) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      console.error('Error updating context post:', error);
      res.status(500).json({ error: 'Failed to update context post' });
    }
  } finally {
    await session.close();
  }
});

router.delete('/conversations/:conversationId/context/:postId', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const conversationId = String(req.params.conversationId);
  const postId = String(req.params.postId);

  const session = getDriver().session();
  try {
    await deleteContextPost(
      session,
      userId,
      conversationId,
      postId,
      req.agentKeyId,
      req.agentScopes
    );
    res.status(204).send();
  } catch (error: any) {
    if (error instanceof ContextLaneError) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      console.error('Error deleting context post:', error);
      res.status(500).json({ error: 'Failed to delete context post' });
    }
  } finally {
    await session.close();
  }
});

router.post('/conversations/:conversationId/context/:postId/report', async (req: Request, res: Response) => {
  const session = getDriver().session();
  try {
    const result = await reportContextPost(session, req.user!.userId, String(req.params.conversationId),
      String(req.params.postId), req.body?.reason, req.body?.freeform, req.agentKeyId, req.agentScopes);
    res.status(201).json(result);
  } catch (error: any) {
    if (error instanceof ContextLaneError) res.status(error.statusCode).json({ error: error.message });
    else { console.error('Error reporting context post:', error); res.status(500).json({ error: 'Failed to report context post' }); }
  } finally { await session.close(); }
});

async function agentRequestRoute(req: Request, res: Response, action: (session: ReturnType<ReturnType<typeof getDriver>['session']>) => Promise<unknown>) {
  const session = getDriver().session();
  try { res.json(await action(session)); }
  catch (error: any) {
    if (error instanceof ContextLaneError) res.status(error.statusCode).json({error:error.message});
    else { console.error('Context agent request failed:',error); res.status(500).json({error:'Context agent request failed'}); }
  } finally { await session.close(); }
}
router.get('/context-agent/preferences', (req, res) => agentRequestRoute(req, res, session => {
  const keyId = req.agentKeyId || req.query.keyId;
  return contextAgentPreference(session, req.user!.userId, keyId as string);
}));
router.put('/context-agent/preferences', (req, res) => agentRequestRoute(req, res, session => {
  if (typeof req.body?.enabled !== 'boolean') throw new ContextLaneError(400,'enabled must be a boolean');
  if (req.agentKeyId && req.body.keyId && req.body.keyId !== req.agentKeyId) throw new ContextLaneError(403,'An agent can only configure its own key');
  return contextAgentPreference(session, req.user!.userId, req.agentKeyId || req.body.keyId, req.body.enabled);
}));
router.post('/conversations/:conversationId/context/:postId/ask-agents', (req, res) => agentRequestRoute(req, res, session =>
  askContextAgents(session, req.user!.userId, String(req.params.conversationId), String(req.params.postId), req.agentKeyId, req.agentScopes)));
router.get('/context-agent/requests', (req, res) => agentRequestRoute(req, res, session =>
  listContextAgentRequests(session, req.user!.userId, req.agentKeyId!)));
router.post('/context-agent/requests/:requestId/respond', (req, res) => agentRequestRoute(req, res, session => {
  if (req.body?.decline !== undefined && typeof req.body.decline !== 'boolean') throw new ContextLaneError(400,'decline must be a boolean');
  return respondToContextAgentRequest(session, req.user!.userId, req.agentKeyId!, req.agentScopes, String(req.params.requestId), req.body?.text, req.body?.decline);
}));

export default router;