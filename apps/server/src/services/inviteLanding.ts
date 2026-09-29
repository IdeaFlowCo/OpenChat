/** Actions on the public invite page, in the order a visitor needs them. */
export function renderInviteActions(token: string): string {
  const encoded = encodeURIComponent(token).replace(/'/g, '%27');
  return `<a class="cta cta-primary" href="openchat://invite/${encoded}">Open in OpenChat</a>
  <a class="cta cta-secondary" href="/app/?intent=invite&amp;token=${encoded}">Join on the web</a>
  <a class="cta cta-secondary" href="https://apps.apple.com/us/app/openchat-agentic-chat/id6774991932">Get the iOS app · App Store</a>
  <p class="cta-tiny">Installing first? <button type="button" onclick="copyInvite()">Copy Invite Link</button>, then paste it at sign-in.</p>`;
}
