/** Actions on the public invite page, in the order a visitor needs them. */
export function renderInviteActions(token: string): string {
  const encoded = encodeURIComponent(token).replace(/'/g, '%27');
  return `<a class="cta cta-primary" href="openchat://invite/${encoded}">Open in OpenChat</a>
  <a class="cta cta-secondary" href="/app/?intent=invite&amp;token=${encoded}">Join on the web</a>
  <a class="cta cta-secondary" href="https://apps.apple.com/us/app/openchat-agentic-chat/id6774991932">Get the iOS app · App Store</a>
  <p class="cta-tiny">Installing first? <button type="button" onclick="copyInvite()">Copy Invite Link</button>, then paste it at sign-in.</p>`;
}

/**
 * The static head of the public invite page. Link previews (iMessage, Slack,
 * search crawlers) read only this, and it never names the group, its members
 * or its size: an invite link is forwarded and unfurled by machines that are
 * not the invited person. The group's name appears in the page body and, via
 * `inviteTabTitleScript`, in the tab title of the person who opened the link.
 */
export function renderInvitePreviewHead(): string {
  const title = 'You\u2019re invited to a group chat on OpenChat';
  const description = 'Open the invite to see the group and join.';
  return `<title>Group invite \u00b7 OpenChat</title>
<meta name="description" content="${description}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary">
<meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="no-referrer">`;
}

/** One script statement that names the group in the visitor's tab. Safe inside an inline <script>. */
export function inviteTabTitleScript(groupTitle: string): string {
  const literal = JSON.stringify(`Join ${groupTitle} \u00b7 OpenChat`).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `document.title = ${literal};`;
}

/**
 * "Open in OpenChat" uses the app's own link scheme, which does nothing for a
 * visitor who has not installed the app. If the page is still in front a
 * moment after the tap, continue on the web so the invite is never a dead end.
 * One script statement, safe inside an inline <script>.
 */
export function inviteAppFallbackScript(token: string): string {
  const web = JSON.stringify(`/app/?intent=invite&token=${encodeURIComponent(token).replace(/'/g, '%27')}`).replace(/</g, '\\u003c');
  return `(function(){var app=document.querySelector('a.cta-primary');if(!app)return;app.addEventListener('click',function(){var left=false;` +
    `var mark=function(){if(document.hidden)left=true;};document.addEventListener('visibilitychange',mark);` +
    `setTimeout(function(){document.removeEventListener('visibilitychange',mark);if(!left&&!document.hidden)location.href=${web};},1600);});})();`;
}
