# OpenChat domain rollout

The target canonical public host is `chat.ideaflow.app`. Keep `chat.globalbr.ai`
serving the same OpenChat backend and responsive client indefinitely for old
bookmarks, installed native clients, Universal Links, and OAuth state held in
that browser origin. Do not redirect the old host during this rollout.

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
