import { afterEach, expect, it, vi } from 'vitest';
import { searchPublicNoos } from '../src/services/appSources.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('searches the configured API and links results to the configured web client', async () => {
  vi.stubEnv('NOOS_API_URL', 'http://localhost:52743');
  vi.stubEnv('NOOS_WEB_URL', 'http://localhost:33217');
  const fetch = vi.fn().mockResolvedValue(Response.json({ nodes: [{ id: '1', slug: 'local note' }] }));
  vi.stubGlobal('fetch', fetch);

  const result = await searchPublicNoos('two words');
  expect(fetch).toHaveBeenCalledWith('http://localhost:52743/api/nodes/search/two%20words?limit=10', expect.objectContaining({ redirect: 'error' }));
  expect(result).toMatchObject({ scope: 'public_only', nodes: [{ url: 'http://localhost:33217/n/local%20note' }] });
});
