import { describe, expect, it } from 'vitest';
import { getIdeaflowPasswordResetUrl } from '../src/services/ideaflowOidc';
const env = { IDEAFLOW_ID_ENABLED: 'true', IDEAFLOW_ID_CLIENT_ID: 'fixture-id',
  IDEAFLOW_ID_CLIENT_SECRET: 'fixture-secret', IDEAFLOW_ID_REDIRECT_URI: 'https://chat.example/auth/callback',
  IDEAFLOW_ID_ISSUER: 'https://id.example/api/auth' };
const on = { ...env, IDEAFLOW_PASSWORD_RESET_ENABLED: 'true', IDEAFLOW_PASSWORD_RESET_URL: 'https://id.example/forgot-password' };
describe('separate provider recovery capability', () => {
  it('defaults off despite enabled login', () => {
    expect(getIdeaflowPasswordResetUrl(env)).toBeNull();
    expect(getIdeaflowPasswordResetUrl({ ...env, IDEAFLOW_PASSWORD_RESET_URL: on.IDEAFLOW_PASSWORD_RESET_URL })).toBeNull();
  });
  it('allows exact provider route after separate opt-in', () => { expect(getIdeaflowPasswordResetUrl(on)).toBe(on.IDEAFLOW_PASSWORD_RESET_URL); });
  it.each(['https://other.example/forgot-password', 'http://id.example/forgot-password', 'https://id.example/reset-password',
    'https://id.example/forgot-password?email=a@example.com', 'https://id.example/forgot-password#token',
    'https://user:secret@id.example/forgot-password', 'https://id.example/forgot-password/'])('rejects unsafe or mismatched destination %s', url => {
    expect(getIdeaflowPasswordResetUrl({ ...on, IDEAFLOW_PASSWORD_RESET_URL: url })).toBeNull();
  });
  it('requires enabled login credentials and a provider without userinfo', () => {
    expect(getIdeaflowPasswordResetUrl({ ...on, IDEAFLOW_ID_ENABLED: 'false' })).toBeNull();
    expect(getIdeaflowPasswordResetUrl({ ...on, IDEAFLOW_ID_CLIENT_SECRET: '' })).toBeNull();
    expect(getIdeaflowPasswordResetUrl({ ...on, IDEAFLOW_ID_ISSUER: 'https://user:secret@id.example/api/auth' })).toBeNull();
  });
});
