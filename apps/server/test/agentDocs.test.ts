import express from 'express';
import request from 'supertest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { marked } from 'marked';
import { expect, it } from 'vitest';
import { createAgentDocsRouter } from '../src/routes/agentDocs.js';
const docsDir = path.resolve('dist/docs');
const app = express();
app.use('/agents', createAgentDocsRouter(docsDir));
app.get(['/agents', '/about/connect-your-bot'], (_req, res) => res.type('html').send(marked.parse(readFileSync(path.join(docsDir, 'connect-your-bot.md'), 'utf8'))));
const localLinks = (html: string) => [...html.matchAll(/href="(\/agents\/[^"#]+)"/g)].map(match => match[1]);
it('serves the three built guides through discoverable public links from both setup doors', async () => {
  for (const door of ['/agents', '/about/connect-your-bot']) {
    const guide = await request(app).get(door); expect(guide.status).toBe(200);
    const links = new Set(localLinks(guide.text)); expect(links).toEqual(new Set(['/agents/conversation-content', '/agents/context-intentions', '/agents/context-webhooks']));
    for (const link of links) {
      const response = await request(app).get(link);
      expect(response.status).toBe(200); expect(response.type).toBe('text/html'); expect(response.text).toContain('<h1>');
      expect(response.text).toContain('https://id.ideaflow.app/agents'); expect(response.text).toContain('direct signed-in session');
      expect(response.headers['cache-control']).toBe('public, max-age=300');
    }
  }
});
it('rewrites sibling guide links to their public routes and never exposes arbitrary repository files', async () => {
  const response = await request(app).get('/agents/conversation-content');
  expect(new Set(localLinks(response.text))).toEqual(new Set(['/agents/context-intentions', '/agents/context-webhooks']));
  for (const link of localLinks(response.text)) expect((await request(app).get(link)).status).toBe(200);
  for (const missing of ['/agents/AGENTS.md', '/agents/package.json', '/agents/context-webhooks.md', '/agents/unknown']) expect((await request(app).get(missing)).status).toBe(404);
  expect(readdirSync(docsDir).sort()).toEqual(['connect-your-bot.md', 'context-intention-lifecycle.md', 'context-webhooks.md', 'conversation-content.md']);
});
it('returns a generic unavailable response rather than a filesystem path when a guide is missing', async () => {
  const unavailable = express(); unavailable.use('/agents', createAgentDocsRouter(path.join(docsDir, 'missing')));
  const response = await request(unavailable).get('/agents/context-webhooks'); expect(response.status).toBe(503); expect(response.text).not.toContain(docsDir);
});
