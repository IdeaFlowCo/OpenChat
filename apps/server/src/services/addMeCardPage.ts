import type { StrangerCard } from './addMeCard.js';

/**
 * Server-rendered /c/:token page: the no-app (and link-preview) face of an
 * AddMe card. Renders only the StrangerCard projection, needs no JS, and
 * hands the add intent to the one /app/ client via ?intent=card&token=... so
 * the invite-onboarding entry plumbing (PR #78) carries it through sign-in.
 */

const APP_STORE_URL = 'https://apps.apple.com/us/app/openchat-agentic-chat/id6774991932';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const PAGE_STYLE = `
  :root { --bg:#0a0c18; --surface:rgba(255,255,255,0.05); --border:rgba(255,255,255,0.10);
          --text:#f4f6ff; --text-dim:#9aa0c5; --accent:#7c80ff; --accent-bg:linear-gradient(135deg,#4f57e8 0%,#8a4cd8 100%); }
  * { box-sizing:border-box; }
  html,body { margin:0; background:var(--bg); color:var(--text); -webkit-font-smoothing:antialiased;
              font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif; line-height:1.5; }
  body::before { content:""; position:fixed; inset:0; z-index:-1;
    background:
      radial-gradient(700px 500px at 20% -10%,#2a2475 0%,transparent 60%),
      radial-gradient(600px 500px at 80% 110%,#6230a8 0%,transparent 55%),
      var(--bg); }
  .wrap { max-width:480px; margin:0 auto; padding:48px 16px; text-align:center; }
  .card { background:var(--surface); border:1px solid var(--border); border-radius:20px; padding:32px 20px 24px; margin-bottom:24px; }
  .avatar { width:96px; height:96px; border-radius:50%; margin:0 auto 16px;
            background:var(--accent-bg); color:#fff; font-size:42px; font-weight:700;
            display:flex; align-items:center; justify-content:center; object-fit:cover; }
  .name { font-size:26px; font-weight:700; margin:0 0 4px; letter-spacing:-0.01em; overflow-wrap:anywhere; }
  .headline { color:var(--text); font-size:16px; margin:0 0 8px; overflow-wrap:anywhere; }
  .status { color:var(--text-dim); font-size:14px; margin:0 0 8px; overflow-wrap:anywhere; }
  .link { display:inline-block; color:var(--accent); font-size:14px; margin-top:4px; overflow-wrap:anywhere; }
  .cta { display:block; padding:14px 22px; margin:10px 0; border-radius:12px;
         font-weight:600; font-size:16px; text-decoration:none; }
  .cta-primary { background:var(--accent-bg); color:#fff; box-shadow:0 8px 20px rgba(124,128,255,0.4); }
  .cta-secondary { background:var(--surface); color:var(--text); border:1px solid var(--border); }
  .cta-tiny { font-size:13px; color:var(--text-dim); padding:8px; }
  .cta-tiny a { color:var(--accent); text-decoration:underline; }
  .footer { font-size:11px; color:var(--text-dim); margin-top:30px; }
  .footer a { color:var(--text-dim); }
`;

export function renderCardPage(card: StrangerCard, token: string): string {
  const name = escapeHtml(card.name);
  const encodedToken = encodeURIComponent(token);
  const intentQs = `?intent=card&token=${encodedToken}`;
  const initial = escapeHtml((card.name[0] || '?').toUpperCase());
  const status = card.status
    ? [card.status.emoji, card.status.text].filter(Boolean).join(' ')
    : '';
  const description = card.headline
    ? `${card.name} · ${card.headline}. Add them on OpenChat.`
    : `Add ${card.name} on OpenChat.`;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#5664e2">
<meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="no-referrer">
<title>${name} on OpenChat</title>
<meta name="description" content="${escapeHtml(description)}">
<meta property="og:title" content="${name} on OpenChat">
<meta property="og:description" content="${escapeHtml(description)}">
<meta name="apple-itunes-app" content="app-id=6774991932, app-argument=https://chat.globalbr.ai/c/${encodedToken}">
<style>${PAGE_STYLE}</style>
</head><body>
<div class="wrap">
  <div class="card">
    ${card.avatarUrl
      ? `<img class="avatar" src="${escapeHtml(card.avatarUrl)}" alt="">`
      : `<div class="avatar">${initial}</div>`}
    <h1 class="name">${name}${card.isBot ? ' <span style="font-size:13px;color:var(--text-dim)">· bot</span>' : ''}</h1>
    ${card.headline ? `<p class="headline">${escapeHtml(card.headline)}</p>` : ''}
    ${status ? `<p class="status">${escapeHtml(status)}</p>` : ''}
    ${card.link ? `<a class="link" href="${escapeHtml(card.link)}" rel="noopener nofollow ugc" target="_blank">${escapeHtml(card.link.replace(/^https?:\/\//, ''))}</a>` : ''}
  </div>

  <a class="cta cta-primary" href="/app/${intentQs}">Add ${name} on OpenChat</a>
  <a class="cta cta-secondary" href="${APP_STORE_URL}">Get the iOS app · App Store</a>

  <p class="cta-tiny">Already have OpenChat? <a href="openchat://card/${encodedToken}">Open in the app</a></p>

  <div class="footer">
    <a href="/">chat.globalbr.ai</a> · <a href="/legal/privacy">Privacy</a> · <a href="/legal/terms">Terms</a>
  </div>
</div></body></html>`;
}

export function renderCardUnavailablePage(): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#5664e2">
<meta name="robots" content="noindex,nofollow">
<title>Card unavailable</title>
<style>${PAGE_STYLE}</style>
</head><body>
<div class="wrap">
  <h1 class="name">Card unavailable</h1>
  <p class="status">This card link has been reset or does not exist. Ask its owner for their current code.</p>
  <a class="cta cta-secondary" href="/app/">Open OpenChat</a>
</div></body></html>`;
}
