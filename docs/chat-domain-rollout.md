# OpenChat domain rollout

The canonical public host is `chat.ideaflow.app` (cut over 2026-10-02,
OpenChat-2a5g). `chat.globalbr.ai` is being retired (OpenChat-9cz8): since
2026-10-02 18:22 UTC it redirects browser page navigations to the new host and
keeps proxying everything machine-facing, so installed native builds keep
working. See [Old-host retirement](#old-host-retirement-openchat-9cz8) below;
the sections before it record the original cutover.

## Observed starting point (2026-09-30)

- `chat.globalbr.ai/` and `/app/` return 200 through Cloudflare and the GCE
  `noos_nginx` container.
- `chat.ideaflow.app/` and `/app/` return Vercel 404
  `DEPLOYMENT_NOT_FOUND`. Vercel DNS has no explicit `chat` record; its
  wildcard ALIAS sends the hostname to Vercel. This is a hosting route failure,
  not an OpenChat application 404.
- `noos_nginx` currently has `server_name chat.globalbr.ai` for host port 4001.
  Production `/opt/openchat/.env` has `OPENCHAT_URL` and the IdeaFlow ID callback
  on the old host, with `IDEAFLOW_ID_ENABLED=true`.

## Gates before public cutover

1. Register `https://chat.ideaflow.app/auth/ideaflow/callback` on the existing
   confidential **OpenChat Web** IdeaFlow ID client. Retain
   `https://chat.globalbr.ai/auth/ideaflow/callback` and the existing client ID
   and secret. Do not change shared identity cookies, issuers, or other apps.
2. Add `https://chat.ideaflow.app/auth/google/callback` to the existing Google
   web OAuth client's authorized redirect URIs. Retain the old URI. The client
   requests `prompt=select_account` on both hosts.
3. Arrange HTTPS for the new hostname on the OpenChat origin. Vercel's wildcard
   route cannot serve the Express app or its Socket.IO connection. A dedicated
   TLS reverse proxy or managed HTTPS frontend must forward the Host header,
   `/api/*`, `/app/*`, `/auth/*`, `/i/*`, `/u/*`, `/c/*`, and WebSocket upgrades
   to the same GCE OpenChat port 4001. Add an explicit Vercel DNS record for
   `chat.ideaflow.app` only after this frontend answers HTTPS.

These shared hosting and provider changes require firstmate routing. This
repository's deploy script does not change the existing nginx configuration,
Vercel DNS, or OAuth provider registrations.

## Reversible cutover

Before changing production, save a timestamped copy of the exact Vercel DNS
record set for `chat.ideaflow.app` (including the absence of a `chat` record)
and the current Google and IdeaFlow ID redirect URI lists. On `noos`, use a
private directory for the OpenChat and shared nginx state:

```sh
stamp=$(date -u +%Y%m%dT%H%M%SZ)
sudo install -d -m 700 "/opt/openchat-domain-backups/$stamp"
sudo cp -p /home/ubuntu/noos/nginx.conf "/opt/openchat-domain-backups/$stamp/nginx.conf"
sudo tar -C /opt -czf "/opt/openchat-domain-backups/$stamp/openchat.tar.gz" openchat
sudo docker inspect openchat_app --format '{{.Image}}' | sudo tee "/opt/openchat-domain-backups/$stamp/image-id" >/dev/null
sudo docker image save "$(sudo cat "/opt/openchat-domain-backups/$stamp/image-id")" -o "/opt/openchat-domain-backups/$stamp/openchat-image.tar"
```

The tar includes `.env`; keep the backup directory mode 0700, verify the archive
and saved image before changing the host, and never copy them into this repo.

With the new HTTPS route and both callback registrations ready, deploy the
OpenChat branch, then set production:

```text
OPENCHAT_URL=https://chat.ideaflow.app
CORS_ORIGIN=https://chat.ideaflow.app,https://chat.globalbr.ai,https://social.globalbr.ai
IDEAFLOW_ID_REDIRECT_URI=https://chat.ideaflow.app/auth/ideaflow/callback
```

The route chooses the exact old or new callback from the requesting Host, so
old-host sign-in continues even after that environment change. Recreate the
OpenChat container, then add the explicit `chat` DNS record. Keep the old host
and its proxy route live.

If any check fails, remove or revert only the new `chat.ideaflow.app` DNS
record to the saved absence, restore the saved nginx configuration and the
saved OpenChat archive and image, then recreate only the OpenChat container.
Keep the old `chat.globalbr.ai` nginx server block throughout. Leave both OAuth
redirect registrations in place: additive registrations do not affect existing
sessions. Confirm the old host's `/health`, `/app/`, sign-in, public cards, and
Socket.IO still work.

## Acceptance observations

- On both hosts, `/health`, `/app/`, `/.well-known/apple-app-site-association`
  (JSON, no redirect), `/u/<id>`, `/i/<token>`, and `/c/<token>` work. Old
  links keep their path, query, and invite token; new links encode the new host.
- On each host in a fresh browser tab, Google shows account selection and
  returns to that same host. IdeaFlow ID returns to the same host and resolves
  an existing linked OpenChat user ID. Check that a second existing account
  can be deliberately selected and that neither sign-in creates a duplicate
  OpenChat user. Existing browser sessions on the old origin remain usable;
  the new origin has its own browser storage and requires its own sign-in.
- A real iPhone with the new build opens new `/u/`, `/i/`, and `/c/` Universal
  Links in OpenChat. An already installed old build continues opening old-host
  links and using the old API. The new build also recognizes old-host links.
  Check QR scanning, invite acceptance, a sent message, and Socket.IO receipt.
- Verify the web deployment, native TestFlight build, signed Mac build, and
  physical device behavior separately. A source merge alone updates none of
  these clients.

## Old-host retirement (OpenChat-9cz8)

On 2026-10-02 Jacob decided to retire `chat.globalbr.ai` in favour of
`chat.ideaflow.app`. The old host should redirect people in browsers while
everything machine-facing keeps working through a proxy.

### Redirector (live since 2026-10-02 18:22:12 UTC)

The change is limited to the `server_name chat.globalbr.ai` block in
`/home/ubuntu/noos/nginx.conf` on `noos`. The previous file is saved at
`/opt/openchat-domain-backups/20261002T182212Z-retire-old-host/nginx.conf`.

- **Redirected:** GET or HEAD document navigations get
  `302 https://chat.ideaflow.app$request_uri`, so the path and query are kept.
  These responses carry `Cache-Control: no-store` and
  `Vary: Sec-Fetch-Dest, Accept`. A request counts as a navigation when it
  sends `Sec-Fetch-Dest: document`, or when it sends no Fetch Metadata and an
  `Accept` header that includes `text/html` (older browsers).
- **Proxied as before:** everything else goes to `172.17.0.1:4001`, including:
  - `/api/*`, `/socket.io/*` and any WebSocket upgrade;
  - `/auth/*`, which covers in-flight Google and Ideaflow ID callbacks;
  - `/.well-known/*`, so the AASA file stays `200` JSON with no redirect;
  - `/health`, `/mcp` and `/cdn-cgi/*`;
  - every non-GET request, and subresource or fetch requests;
  - `/app/` requests whose query has `code=`, `state=`, `error=` or `provider=`.
    That OAuth return has to stay on the origin that holds the PKCE state.
  - the GCP uptime check "OpenChat production HTTPS".
- **Deprecation headers:** proxied responses carry `Deprecation: @1790899200`
  (2026-10-02, RFC 9745) and
  `Link: <https://chat.ideaflow.app>; rel="successor-version"`.
- **Rollback:** write the backup over the file in place. The file is a
  single-file bind mount, so the inode must not change. Then run
  `docker exec noos_nginx nginx -t` and `nginx -s reload`.

The redirect is a 302 during the soak period. Once it is stable, switch it to
301 by editing that one `return`; browsers cache 301s hard.

**What browser users experience.** Each host has its own cookies and storage,
so a web user who was signed in on the old host has to sign in once on
`chat.ideaflow.app`. An OAuth sign-in that began on the old host still
completes there, but the next full page load moves the user to the new host.
The old-origin service worker is network-first, so it passes the redirect
through.

### Who still depends on the old host

- **Native iOS builds.**
  - Only TestFlight 1.0.4 (111) can receive the 1.0.4 OTA, which moves its API
    host to `chat.ideaflow.app`.
  - App Store 1.0.1 (build 103) and 1.0 (91), and TestFlight builds up to 110,
    have `chat.globalbr.ai` compiled in. They cannot receive that OTA.
  - Those builds also create invite and card links on the old host, because the
    server derives link origins from the request Host.
  - Builds up to 108 have no associated domains. Builds 109 and 110 have only
    `applinks:chat.globalbr.ai`.
- **Machine clients:**
  - picortex (`136.109.101.253`, `OPENCHAT_BASE_URL` in its bot env) polls
    `/api/chat/conversations`.
  - An axios client at `34.20.227.76`, probably groupbrain on Cloud Run.
  - The GCP uptime check.
  - The stage connector's `MCP_OPENCHAT_ORIGIN`.
- **OAuth registrations:** the Google web client and the Ideaflow ID OpenChat
  Web client both still list the `chat.globalbr.ai` callback.

### Measuring old-host traffic

`infra/old-host-traffic.py [hours]` queries Cloudflare analytics for
`chat.globalbr.ai` and reports status, path, user agent and client IP. Native
iOS requests identify the build as `OpenChat/<build> CFNetwork/...`. The noos
nginx log does not record Host, so use Cloudflare for per-host counts.

Baseline for 2026-10-01 18:15 to 2026-10-02 18:15 UTC, before the redirector:
about 11k requests.

| Source | Requests |
|---|---|
| GCP uptime check | 5.8k |
| picortex `node` poller | 2.9k |
| Desktop Chrome web sessions | 1.7k |
| `OpenChat/110` | 188 |
| `OpenChat/103` | 44 |
| `OpenChat/111` | 21 |
| Bots and unfurlers | the rest |

### Gates before shutting `chat.globalbr.ai` off

1. **New App Store build.** It must carry both `applinks:chat.ideaflow.app`
   and `applinks:chat.globalbr.ai`, use runtime 1.0.4 or later, and have
   `chat.ideaflow.app` as its default API host. It goes through TestFlight,
   then App Store review, and must be live. Build 108 (App Store 1.0.2, not
   yet submitted) does not qualify: it has the old host compiled in and no
   associated domains.
2. **Users have updated.** `OpenChat/<build>` requests at or below 110 should
   be near zero for at least 14 days. TestFlight builds 108–110 expire on
   2026-12-28, but App Store builds never expire, so only update adoption
   ends their traffic. Consider a server-driven "please update" prompt for
   old builds.
3. **Machine clients have moved.** picortex, groupbrain, the stage connector
   and any MCP or bot configs must point at `chat.ideaflow.app`. Then
   `node`, `axios` and empty-UA `/api` and `/socket.io` traffic should be
   about zero.
4. **Monitoring has moved.** Point the uptime check at `chat.ideaflow.app`.
5. **Switch to 301.** Change the redirect to 301 and soak.
6. **Remove the old OAuth callbacks last,** after old-host `/auth/*` and
   `/api/auth/*/url` traffic has been zero for a while. Remove
   `chat.globalbr.ai/auth/google/callback` from the Google web client and
   `chat.globalbr.ai/auth/ideaflow/callback` from the Ideaflow ID client.
7. **Final cutover.** Keep the AASA and the old block until universal-link
   use of old-host links (`/i/`, `/u/`, `/c/` shared in chats, QR codes and
   cards) is acceptable to break, or keep a permanent redirect-only host.
   Only then remove the nginx block and the Cloudflare DNS record.
