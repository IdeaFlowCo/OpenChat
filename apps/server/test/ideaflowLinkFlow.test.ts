import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  consumeIdeaflowLinkFlow,
  IDEAFLOW_LINK_FLOW_TTL_MS,
  rememberIdeaflowLinkFlow,
  resetIdeaflowLinkFlows,
} from '../src/services/ideaflowLinkFlow.js';

const verifier = 'v'.repeat(64);
const challenge = createHash('sha256').update(verifier).digest('base64url');
const base = {
  state: 'link.' + 's'.repeat(32),
  userId: 'user-a',
  authorization: 'Bearer session-a',
  nonce: 'n'.repeat(32),
};

describe('Ideaflow link flow registry', () => {
  beforeEach(resetIdeaflowLinkFlows);

  it('matches the initiating user, exact session, nonce, and PKCE verifier once', () => {
    expect(rememberIdeaflowLinkFlow({ ...base, codeChallenge: challenge }, 100)).toBe(true);
    expect(consumeIdeaflowLinkFlow({ ...base, codeVerifier: verifier }, 101)).toBe(true);
    expect(consumeIdeaflowLinkFlow({ ...base, codeVerifier: verifier }, 102)).toBe(false);
  });

  it.each([
    { label: 'account switch', override: { userId: 'user-b', authorization: 'Bearer session-b' } },
    { label: 'replacement session', override: { authorization: 'Bearer replacement-session' } },
    { label: 'nonce mismatch', override: { nonce: 'x'.repeat(32) } },
    { label: 'PKCE mismatch', override: { codeVerifier: 'x'.repeat(64) } },
  ])('burns the flow on $label', ({ override }) => {
    expect(rememberIdeaflowLinkFlow({ ...base, codeChallenge: challenge }, 100)).toBe(true);
    expect(consumeIdeaflowLinkFlow({ ...base, codeVerifier: verifier, ...override }, 101)).toBe(false);
    expect(consumeIdeaflowLinkFlow({ ...base, codeVerifier: verifier }, 102)).toBe(false);
  });

  it('expires and refuses duplicate state without overwriting the original flow', () => {
    expect(rememberIdeaflowLinkFlow({ ...base, codeChallenge: challenge }, 100)).toBe(true);
    expect(rememberIdeaflowLinkFlow({
      ...base,
      userId: 'user-b',
      authorization: 'Bearer session-b',
      codeChallenge: challenge,
    }, 101)).toBe(false);
    expect(consumeIdeaflowLinkFlow({ ...base, codeVerifier: verifier }, 100 + IDEAFLOW_LINK_FLOW_TTL_MS)).toBe(false);
  });
});
