import { Router } from 'express';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

const guides = {
  'conversation-content': { file: 'conversation-content.md', title: 'Conversation content' },
  'context-intentions': { file: 'context-intention-lifecycle.md', title: 'Context intention lifecycle' },
  'context-webhooks': { file: 'context-webhooks.md', title: 'Context request webhooks' },
} as const;
const publicDocLinks = Object.fromEntries(Object.entries(guides).map(([slug, guide]) => [guide.file, `/agents/${slug}`]));
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

/** Explicit allowlist only: never expose the repo's other Markdown files. */
export function createAgentDocsRouter(docsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs')) {
  const router = Router();
  for (const [slug, guide] of Object.entries(guides)) {
    router.get(`/${slug}`, (_req, res) => {
      try {
        let body = marked.parse(readFileSync(path.join(docsDir, guide.file), 'utf8'), { async: false }) as string;
        body = body.replace(/href="([^"]+)"/g, (original, href: string) => publicDocLinks[href] ? `href="${publicDocLinks[href]}"` : original);
        res.set('Cache-Control', 'public, max-age=300');
        res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(guide.title)} — OpenChat</title><style>
:root{color-scheme:light dark;--bg:#fff;--text:#202124;--muted:#555b64;--border:#dce0e5;--surface:#f5f6f8;--link:#345cc7}
@media(prefers-color-scheme:dark){:root{--bg:#181a1e;--text:#e9ebef;--muted:#aeb5c0;--border:#353a43;--surface:#23272e;--link:#a8bcff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.65 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:820px;margin:0 auto;padding:20px 24px 60px;overflow-wrap:anywhere}nav{display:flex;flex-wrap:wrap;gap:4px 20px;border-bottom:1px solid var(--border);padding-bottom:12px;margin-bottom:24px}nav a{display:inline-flex;align-items:center;min-height:44px;font-size:14px;font-weight:600}a{color:var(--link);text-underline-offset:3px}a:focus-visible{outline:2px solid var(--link);outline-offset:4px}h1{font-size:28px;line-height:1.25;letter-spacing:-.02em}h2{font-size:21px;line-height:1.3;margin-top:32px}h3{font-size:18px}code{font-size:.9em;background:var(--surface);padding:2px 5px;border-radius:4px}pre{padding:16px;background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:auto}pre code{padding:0}table{display:block;max-width:100%;overflow:auto;border-collapse:collapse}td,th{padding:8px 12px;text-align:left;border-bottom:1px solid var(--border)}.note{color:var(--muted);font-size:14px}
</style></head><body><main><nav aria-label="Agent setup"><a href="https://id.ideaflow.app/agents">Connect an agent</a><a href="/agents">OpenChat setup</a><a href="/api/docs">API reference</a></nav><article>${body}</article><p class="note">Agent access does not grant permission to approve private sharing, change intention lifecycle, or configure webhook destinations. Those actions require the owner's direct signed-in session.</p></main></body></html>`);
      } catch {
        res.status(503).type('text/plain').send('This agent guide is temporarily unavailable.');
      }
    });
  }
  return router;
}
export default createAgentDocsRouter();
