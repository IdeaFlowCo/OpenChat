# Security events

`securityEvent(event, outcome, fields)` (`apps/server/src/services/securityEvent.ts`)
writes one JSON line to the `openchat_app` container's stdout (Docker
json-file; the host's hourly archiver ships container logs to GCS):

```sh
sudo docker logs --since 1h openchat_app 2>&1 | grep '"security_event"'
```

Shape: `{"security_event", "outcome": "success|failure|denied", "ts", "ip",
"ua" (≤200 chars), "path", "method", "user_id"?, "agent_key_id"?, ...extras}`.
`cf_connecting_ip` and `xff` appear only when the TCP peer is a trusted proxy
hop; they are edge/client-supplied context, not authenticated facts.

Never logged: passwords, tokens, agent keys, OTP codes, session ids, cookies.
Credential-looking keys are dropped by the emitter; `email` becomes
`email_domain` + `email_hash` (first 12 hex of sha256 of the lowercased email).

`trust proxy` is `loopback, linklocal, uniquelocal` (was `true`). With `true`,
`req.ip` was the leftmost X-Forwarded-For entry, which any client can set.
Now it is the address noos_nginx saw: the real client for direct traffic, the
Cloudflare/GCP-LB edge for fronted hosts until nginx restores the client
address with `real_ip` (nginx config is owned outside this repo).
`req.protocol` still honours nginx's X-Forwarded-Proto.

| Event | Outcomes | Source |
|---|---|---|
| `login` | success / failure | Ideaflow, Google (web + iOS), Apple sign-in |
| `logout` | success | `POST /api/auth/logout` |
| `bridge_exchange` | success / failure | `POST /api/auth/bridge-exchange` |
| `account_update` | success | `PATCH /api/auth/me`, `PUT /api/auth/me/status` (field names only) |
| `account_delete` | success / failure | `DELETE /api/auth/me` |
| `api_auth` | failure / denied | `requireAuth`, `resolveActor` (bad/expired JWT, bad agent key, missing credentials, delegation mismatch), embedded-session refusals |
| `partner_auth` | failure | Unlinked/partner/Vision shared-secret routes |
| `agent_key_create`, `agent_key_reveal`, `agent_key_update`, `agent_key_revoke` | success / failure | `/api/agent-keys` |
| `rate_limited` | denied | every HTTP 429 response |
