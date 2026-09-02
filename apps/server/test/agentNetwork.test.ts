import { describe, expect, it } from 'vitest';
import {
  applyMatchDecision,
  projectMatchForViewer,
  scoreIntentPair,
} from '../src/services/agentNetwork.js';

const noProviders = {
  embeddingScore: async () => null,
  verify: async () => true,
};

describe('quiet-match scoring', () => {
  it('matches a complementary ask and offer above threshold', async () => {
    const score = await scoreIntentPair(
      { id: 'ask', ownerUserId: 'a', kind: 'ask', terms: 'React accessibility review' },
      { id: 'offer', ownerUserId: 'b', kind: 'offer', terms: 'React accessibility consulting' },
      { ...noProviders, threshold: 0.5 },
    );
    expect(score).toBeGreaterThanOrEqual(0.5);
  });

  it('rejects same-kind and same-owner pairs before provider scoring', async () => {
    const sameKind = await scoreIntentPair(
      { id: 'a', ownerUserId: 'one', kind: 'ask', terms: 'React help' },
      { id: 'b', ownerUserId: 'two', kind: 'ask', terms: 'React help' },
      { ...noProviders, threshold: 0 },
    );
    const sameOwner = await scoreIntentPair(
      { id: 'a', ownerUserId: 'one', kind: 'ask', terms: 'React help' },
      { id: 'b', ownerUserId: 'one', kind: 'offer', terms: 'React help' },
      { ...noProviders, threshold: 0 },
    );
    expect(sameKind).toBeNull();
    expect(sameOwner).toBeNull();
  });

  it('rejects a complementary pair below threshold', async () => {
    expect(await scoreIntentPair(
      { id: 'ask', ownerUserId: 'a', kind: 'ask', terms: 'garden irrigation' },
      { id: 'offer', ownerUserId: 'b', kind: 'offer', terms: 'typescript mentoring' },
      { ...noProviders, threshold: 0.5 },
    )).toBeNull();
  });
});

describe('quiet-match state machine', () => {
  const proposed = { status: 'proposed', aResponse: null, bResponse: null } as const;

  it('connects only after both sides approve', () => {
    const first = applyMatchDecision(proposed, 'a', 'approve');
    expect(first.state).toEqual({ status: 'proposed', aResponse: 'approved', bResponse: null });
    expect(applyMatchDecision(first.state, 'b', 'approve').state.status).toBe('connected');
  });

  it('closes immediately on decline and cannot be reopened or reproposed', () => {
    const declined = applyMatchDecision(proposed, 'b', 'decline');
    expect(declined.state.status).toBe('closed');
    const repeated = applyMatchDecision(declined.state, 'a', 'approve');
    expect(repeated).toEqual({ state: declined.state, alreadyResolved: true });
  });

  it('treats repeated responses as idempotent', () => {
    const first = applyMatchDecision(proposed, 'a', 'approve');
    expect(applyMatchDecision(first.state, 'a', 'decline')).toEqual({
      state: first.state,
      alreadyResolved: false,
    });
  });
});

describe('per-viewer match projection', () => {
  it('never leaks identity, details, or the other response state', () => {
    const projection = projectMatchForViewer({
      id: 'match',
      matchStatus: 'proposed',
      ownResponse: 'approved',
      ownIntent: {
        id: 'mine', kind: 'ask', terms: 'accessibility review',
        ownerUserId: 'me', details: 'private source message',
      },
      otherIntent: {
        id: 'theirs', kind: 'offer', terms: 'accessibility consulting',
        ownerUserId: 'secret-user', details: 'secret details',
      },
      createdAt: '2026-09-02T00:00:00Z',
      updatedAt: '2026-09-02T00:00:00Z',
    });

    expect(projection.status).toBe('awaiting_other');
    expect(JSON.stringify(projection)).not.toMatch(/secret-user|private source|secret details|Response|ownerUserId/);
    expect(projection).toEqual(expect.objectContaining({
      ownIntent: { id: 'mine', kind: 'ask', terms: 'accessibility review' },
      otherKind: 'offer',
      otherTerms: 'accessibility consulting',
    }));
  });
});
