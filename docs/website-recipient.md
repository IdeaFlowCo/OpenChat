# Website recipients

From Chats, open **New message** and enter a website or page in **To**. The
draft stays on the device until you choose an action. Paste in an existing
message composer keeps its ordinary behavior.

**Ask my agent** retrieves the public HTTPS page using an anonymous GET.
The OpenChat Agent answers privately in the draft with a source URL and
a supporting passage. When the page is unavailable or the excerpt is
insufficient, you can choose text to share with your agent. The page request
carries no question, account data, or chat history. The model receives the
question and excerpt with no tools. It can answer or report insufficient
evidence.

**Find official representative** checks the domain’s designation. OpenChat
shows the recipient, verified domain, delegated host when applicable, and
the exact message. **Send to [domain]** rechecks the designation and sends
through the normal OpenChat direct conversation. Separate pages can use the
same account and DM. Each message carries its own reviewed page context.
Replies carry the actual OpenChat sender’s attribution.

OpenChat excludes URL credentials, custom ports, queries, fragments, and
paths with opaque or sensitive segments from automatic reads and context
sharing. Public reads do not follow redirects. A page may be unavailable
when it needs sign-in or client-side rendering.

## Publishing an official representative

The representative uses an existing OpenChat account. To receive and reply
programmatically, configure that account’s existing OpenChat agent
connection. The website and representative each control their own keys.

1. Sign an empty-content Nostr kind 30078 event with the representative
   key. Use these tags, in order:

   ```text
   ["d", "openchat-website-binding:v1:<domain>"]
   ["openchat-user", "<representative's OpenChat user ID>"]
   ["host", "<representative's hosting domain>"]
   ["expiration", "<Unix seconds>"]
   ```

2. As the specified representative, use a direct OpenChat session to call
   `PUT /api/chat/website-recipient/binding` with `{"event": <signed event>}`.
   A new binding replaces that account’s previous binding for the domain.
   `DELETE /api/chat/website-recipient/binding/:domain` revokes it.
3. At `https://<domain>/.well-known/nostr.json?name=agent`, return a NIP-05
   document with `names._` containing the domain key and `names.agent`
   containing the representative key, both lowercase hex. Include the
   registered event as `openchat_agent.binding`.
4. For a different hosting domain, also publish
   `openchat_agent.delegation`. The domain key signs an empty-content
   kind 30078 event with these exact tags in order:

   ```text
   ["d", "openchat-website-delegation:v1:<domain>"]
   ["p", "<representative's lowercase hex public key>"]
   ["host", "<representative's hosting domain>"]
   ["expiration", "<Unix seconds>"]
   ```

Both events must be current. Rotating the representative or changing its
binding requires a fresh review. Existing conversations retain their
OpenChat participants.
