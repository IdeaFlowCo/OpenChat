/**
 * Legal routes — Privacy Policy and Terms of Service (OpenChat-wfz)
 *
 * GET /legal/privacy  → privacy.md rendered as HTML
 * GET /legal/terms    → terms.md rendered as HTML
 */
import { Router, Request, Response } from 'express';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { marked } from 'marked';

const router = Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve paths relative to the src/routes directory — works in both
// development (ts-node/tsx, __dirname = src/routes) and production
// (dist/routes, siblings of dist/legal). The legal .md files are
// copied to dist/legal by the build process (see tsconfig include).
function legalPath(filename: string): string {
  return join(__dirname, '..', 'legal', filename);
}

function renderPage(title: string, mdContent: string): string {
  const body = marked.parse(mdContent) as string;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title} — OpenChat</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }

    :root {
      --bg: #ffffff;
      --fg: #1a1a1a;
      --muted: #555;
      --link: #0070f3;
      --border: #e0e0e0;
      --max-w: 720px;
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0d0d0d;
        --fg: #f0f0f0;
        --muted: #aaa;
        --link: #60a5fa;
        --border: #333;
      }
    }

    body {
      background: var(--bg);
      color: var(--fg);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 16px;
      line-height: 1.7;
      margin: 0;
      padding: 24px 16px 64px;
    }

    .container {
      max-width: var(--max-w);
      margin: 0 auto;
    }

    .back-link {
      display: inline-block;
      margin-bottom: 24px;
      color: var(--link);
      text-decoration: none;
      font-size: 0.9rem;
    }
    .back-link:hover { text-decoration: underline; }

    h1 { font-size: 1.8rem; margin-top: 0; }
    h2 { font-size: 1.25rem; margin-top: 2rem; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
    h3 { font-size: 1.05rem; margin-top: 1.5rem; }

    p, li { color: var(--fg); }
    ul, ol { padding-left: 1.5rem; }
    a { color: var(--link); }

    strong { font-weight: 600; }

    hr { border: none; border-top: 1px solid var(--border); margin: 2rem 0; }
  </style>
</head>
<body>
  <div class="container">
    <a class="back-link" href="https://chat.globalbr.ai">← Back to chat.globalbr.ai</a>
    ${body}
  </div>
</body>
</html>`;
}

router.get('/privacy', (_req: Request, res: Response) => {
  try {
    const md = readFileSync(legalPath('privacy.md'), 'utf-8');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderPage('Privacy Policy', md));
  } catch (e) {
    console.error('Failed to load privacy.md:', e);
    res.status(500).send('Privacy policy unavailable');
  }
});

router.get('/terms', (_req: Request, res: Response) => {
  try {
    const md = readFileSync(legalPath('terms.md'), 'utf-8');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderPage('Terms of Service', md));
  } catch (e) {
    console.error('Failed to load terms.md:', e);
    res.status(500).send('Terms of service unavailable');
  }
});

export default router;
