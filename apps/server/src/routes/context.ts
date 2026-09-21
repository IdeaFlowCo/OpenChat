import { Router, Request, Response } from 'express';
import { getDriver } from '../db.js';
import { resolveActor } from '../middleware/resolveActor.js';
import { isContextLaneEnabled } from '../config/features.js';
import {
  createContextPost,
  updateContextPost,
  deleteContextPost,
  listContextPosts,
  ContextLaneError
} from '../services/contextLane.js';

const router = Router();

function requireFeatureFlag(req: Request, res: Response, next: Function) {
  if (!isContextLaneEnabled()) {
    res.status(404).json({ error: 'Context Lane feature is not enabled' });
    return;
  }
  next();
}

// All context routes use the feature flag and actor resolution
router.use('/conversations/:conversationId/context', requireFeatureFlag, resolveActor);

router.get('/conversations/:conversationId/context', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const conversationId = String(req.params.conversationId);
  const { cursor, limit, kind, search } = req.query;

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
  const { text, kind, clientRequestId, replyToId } = req.body;

  if (!clientRequestId) {
    res.status(400).json({ error: 'clientRequestId is required' });
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
      req.agentScopes
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
  const { text, expectedRevision } = req.body;

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

export default router;