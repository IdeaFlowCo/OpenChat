/** Personal Secretary settings and approved quick answers (OpenChat-3kr.3.1). */

import { Router, Request, Response } from 'express';
import { nanoid } from 'nanoid';
import { getDriver } from '../db.js';
import { resolveActor } from '../middleware/resolveActor.js';

const router = Router();
const MAX_ANSWERS = 50;
const MAX_QUESTION_LENGTH = 200;
const MAX_ANSWER_LENGTH = 2000;

function toJS(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'object' && 'toNumber' in (value as object)) {
    return (value as { toNumber: () => number }).toNumber();
  }
  if (typeof value === 'object' && 'toString' in (value as object) && 'year' in (value as object)) {
    return (value as { toString: () => string }).toString();
  }
  if (Array.isArray(value)) return value.map(toJS);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as object).map(([key, item]) => [key, toJS(item)]));
  }
  return value;
}

function validateText(
  value: unknown,
  field: 'question' | 'answer',
  max: number
): { value?: string; error?: string } {
  if (typeof value !== 'string' || !value.trim()) {
    return { error: `${field} must be a non-empty string` };
  }
  const trimmed = value.trim();
  if (trimmed.length > max) return { error: `${field} must be ${max} characters or fewer` };
  return { value: trimmed };
}

// GET /api/secretary
router.get('/', resolveActor, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const session = getDriver().session();
  try {
    const result = await session.run(
      `MATCH (u:User {id: $userId})
       OPTIONAL MATCH (u)-[:OWNS_SECRETARY_ANSWER]->(entry:SecretaryAnswer)
       WITH u, entry ORDER BY entry.createdAt ASC
       RETURN coalesce(u.secretaryEnabled, false) AS enabled,
              collect(entry { .id, .question, .answer, .createdAt, .updatedAt }) AS answers`,
      { userId }
    );
    if (result.records.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const answers = (toJS(result.records[0]!.get('answers')) as Array<Record<string, unknown>>)
      .filter((entry) => entry?.id);
    res.json({ enabled: result.records[0]!.get('enabled') === true, answers });
  } catch (error) {
    console.error('Error loading secretary settings:', error);
    res.status(500).json({ error: 'Failed to load secretary settings' });
  } finally {
    await session.close();
  }
});

// PATCH /api/secretary { enabled }
router.patch('/', resolveActor, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { enabled } = (req.body ?? {}) as { enabled?: unknown };
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: 'enabled must be a boolean' });
    return;
  }
  const session = getDriver().session();
  try {
    const result = await session.run(
      `MATCH (u:User {id: $userId})
       SET u.secretaryEnabled = $enabled, u.updatedAt = datetime($now)
       RETURN u.secretaryEnabled AS enabled`,
      { userId, enabled, now: new Date().toISOString() }
    );
    if (result.records.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json({ enabled });
  } catch (error) {
    console.error('Error updating secretary settings:', error);
    res.status(500).json({ error: 'Failed to update secretary settings' });
  } finally {
    await session.close();
  }
});

// POST /api/secretary/answers { question, answer }
router.post('/answers', resolveActor, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const question = validateText(req.body?.question, 'question', MAX_QUESTION_LENGTH);
  const answer = validateText(req.body?.answer, 'answer', MAX_ANSWER_LENGTH);
  if (question.error || answer.error) {
    res.status(400).json({ error: question.error ?? answer.error });
    return;
  }

  const session = getDriver().session();
  try {
    const id = nanoid();
    const now = new Date().toISOString();
    const result = await session.run(
      `MATCH (u:User {id: $userId})
       OPTIONAL MATCH (u)-[:OWNS_SECRETARY_ANSWER]->(existing:SecretaryAnswer)
       WITH u, count(existing) AS answerCount
       WHERE answerCount < $maxAnswers
       CREATE (entry:SecretaryAnswer {
         id: $id, question: $question, answer: $answer,
         createdAt: datetime($now), updatedAt: datetime($now)
       })
       CREATE (u)-[:OWNS_SECRETARY_ANSWER]->(entry)
       RETURN entry { .* } AS answer`,
      {
        userId,
        maxAnswers: MAX_ANSWERS,
        id,
        question: question.value,
        answer: answer.value,
        now,
      }
    );
    if (result.records.length === 0) {
      res.status(409).json({ error: `Secretary supports up to ${MAX_ANSWERS} quick answers` });
      return;
    }
    res.status(201).json(toJS(result.records[0]!.get('answer')));
  } catch (error) {
    console.error('Error creating secretary answer:', error);
    res.status(500).json({ error: 'Failed to create secretary answer' });
  } finally {
    await session.close();
  }
});

// PATCH /api/secretary/answers/:id { question, answer }
router.patch('/answers/:id', resolveActor, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const question = validateText(req.body?.question, 'question', MAX_QUESTION_LENGTH);
  const answer = validateText(req.body?.answer, 'answer', MAX_ANSWER_LENGTH);
  if (question.error || answer.error) {
    res.status(400).json({ error: question.error ?? answer.error });
    return;
  }
  const session = getDriver().session();
  try {
    const result = await session.run(
      `MATCH (u:User {id: $userId})-[:OWNS_SECRETARY_ANSWER]->(entry:SecretaryAnswer {id: $id})
       SET entry.question = $question, entry.answer = $answer, entry.updatedAt = datetime($now)
       RETURN entry { .* } AS answer`,
      {
        userId,
        id: req.params.id,
        question: question.value,
        answer: answer.value,
        now: new Date().toISOString(),
      }
    );
    if (result.records.length === 0) {
      res.status(404).json({ error: 'Secretary answer not found' });
      return;
    }
    res.json(toJS(result.records[0]!.get('answer')));
  } catch (error) {
    console.error('Error updating secretary answer:', error);
    res.status(500).json({ error: 'Failed to update secretary answer' });
  } finally {
    await session.close();
  }
});

// DELETE /api/secretary/answers/:id
router.delete('/answers/:id', resolveActor, async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const session = getDriver().session();
  try {
    const result = await session.run(
      `MATCH (u:User {id: $userId})-[:OWNS_SECRETARY_ANSWER]->(entry:SecretaryAnswer {id: $id})
       WITH entry
       DETACH DELETE entry
       RETURN 1 AS deleted`,
      { userId, id: req.params.id }
    );
    const deleted = result.records[0]?.get('deleted');
    const count = typeof deleted?.toNumber === 'function' ? deleted.toNumber() : Number(deleted ?? 0);
    if (count === 0) {
      res.status(404).json({ error: 'Secretary answer not found' });
      return;
    }
    res.json({ ok: true });
  } catch (error) {
    console.error('Error deleting secretary answer:', error);
    res.status(500).json({ error: 'Failed to delete secretary answer' });
  } finally {
    await session.close();
  }
});

export default router;
