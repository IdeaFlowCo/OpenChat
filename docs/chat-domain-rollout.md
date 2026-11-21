# OpenChat domain rollout

The canonical public host is `chat.ideaflow.app`. The existing 2026-10-02 nginx
rule redirects browser document navigations on `chat.globalbr.ai` to the same
path and query on the canonical host, including `/`, `/app/*`, `/i/*`, `/u/*`,
and `/c/*`. Preserve that existing behavior. Machine-facing requests, OAuth
callbacks and returns, Socket.IO/WebSocket, and AASA remain on the old host.
See the verified update below; the September sections describe earlier rollout
planning rather than current production state.

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

## Verified existing browser redirects (2026-11-15)

Owner: root `d3caa262`; execution: `6d59c895`; tracking: `OpenChat-2au`.

Read-only probes accepted the new Google callback (account-selection page,
`prompt=select_account`, no redirect mismatch) and IdeaFlow ID callback
(`prompt=none` returned `login_required` to the correct callback). The existing
ASC reviewer account completed IdeaFlow ID authentication, authorization with
matching state, code exchange, and authenticated `/api/auth/me` on the new
host. No provider registration or credentials changed. Full Google account
sign-in was not performed; its verification boundary is callback acceptance.

The existing October nginx rule already covers root and `/app/*`, so no
additional redirect rule is needed. Its method, Fetch Metadata/Accept, OAuth
query, WebSocket, monitoring, and machine-route guards remain intact. Jacob's
latest direction from root explicitly preserves the existing `/i`, `/u`, and
`/c` browser redirects: no concrete breakage was found to justify narrowing
these. The earlier task-added path restriction was removed, restoring nginx
byte-for-byte to its pre-task configuration. `nginx -t` and graceful reload
passed. The separately deployed System-theme frontend remains intact.

A redundant Cloudflare trial rule was removed. Final readback confirms only
the pre-existing WikiHub redirect rule remains in that phase. No application,
environment, database, DNS, TLS, or provider change was needed for redirects.

### Backups and rollback

The original exact nginx config, private `/opt/openchat` archive, image ID and
saved image remain on Noos in mode-0700 directory:

`/opt/openchat-domain-backups/20261115T091733Z-openchat-browser-only`

Both archives were checked before the initial mutation; secrets/image contents
stayed on Noos. Before restoring the established redirect behavior, a fresh
mode-0700 backup saved the then-current nginx and the restored result:

`/opt/openchat-domain-backups/20261115T094714Z-restore-existing-browser-redirects`

That directory includes `nginx.before.conf`, `nginx.after.conf`, and a
syntax-checked `rollback.py`. The rollback script checks for subsequent shared
nginx changes before restoring the pre-restoration snapshot; that would
reintroduce the superseded narrowing and should only be used deliberately.
The final nginx SHA-256 equals the original pre-task backup:

`d969f84a0c4ebd5167e56647897c15d437d8507db57eae6e64c64dd6f989b1f6`

### Curl acceptance after restoration

| Request on legacy host | Verified result |
| --- | --- |
| HTML `/`, `/app/`, `/app/c/test?x=1` | 302, same path/query on canonical host |
| HTML `/i/test?x=1`, `/u/test?x=1`, `/c/test?x=1` | Existing 302, same path/query on canonical host |
| `/app/` without HTML Accept | 200, no redirect |
| HTML `/app/?code=test&state=test` | 200, same origin |
| `/api/openapi.json`, `/api/auth/ideaflow/config` | 200, no redirect |
| `/auth/ideaflow/callback` | Existing same-origin 302 to `/app/?provider=ideaflow` |
| Socket.IO polling | 200, no redirect |
| Socket.IO WebSocket upgrade | 101 Switching Protocols |
| `/.well-known/apple-app-site-association` | 200, no redirect |

This is HTTP/auth verification, not physical iPhone or macOS behavior validation.
Raw curl headers and sanitized ASC receipts live under
`/home/dev/code/openchat-domain-listing-20261115/evidence` on jacob-dev-1.

### App Store metadata prepared, not submitted

App `6774991932` (`com.jacobcole.openchat`) currently distributes iOS 1.0.6 as
**OpenChat - Agentic Chat**, subtitle **Group chat with AI agents**. Apple had
no editable App Information, so an iOS **1.0.7** draft was created with manual
release and `PREPARE_FOR_SUBMISSION` status. The en-US draft now has:

- Name: **OpenChat: Agentic Chat** (22 characters).
- Subtitle: **by Ideaflow** (11 characters).

Apple accepted the name/subtitle PATCH (HTTP 200), and a separate GET confirmed
the exact values. This establishes acceptance for this app's editable draft;
it is not a guarantee of future App Review approval. The live version remains
unchanged. No build was associated, no review submission was created, and no
TestFlight or App Store submission was performed. Existing ASC key and reviewer
credentials were used in place on M5; no key was copied to Linux or created.

Apple documents the edit-state restrictions in [editable properties](https://developer.apple.com/help/app-store-connect/reference/app-information/required-localizable-and-editable-properties)
and the [localization update API](https://developer.apple.com/documentation/appstoreconnectapi/patch-v1-appinfolocalizations-_id_).
Sanitized before/after receipts also remain on M5 in
`/Users/jacobcole/code/openchat-domain-listing-20261115`.
