# OpenChat production on GCP

Last verified: 2026-08-28

## Live topology

| Layer | Production value |
|---|---|
| Public URL | `https://chat.globalbr.ai` |
| Edge DNS/TLS | Cloudflare |
| GCP project | `lightsail-migration` (`855339352691`) |
| Compute | GCE instance `noos`, `us-central1-a`, static IP `34.10.134.247` |
| Reverse proxy | `noos_nginx` on port 80; routes `chat.globalbr.ai` to host port 4001 |
| Application | `/opt/openchat`, Docker container `openchat_app`, port 4001 |
| Database | Shared `noos_neo4j` container on Docker network `noos_default` |
| Attachments | GCS bucket `openchat-attachments` through its S3-compatible endpoint |
| Backups | GCE snapshot policy `migration-daily-14d` on the boot and attached data disks |

Cloudflare is the public TLS endpoint. The origin currently listens on HTTP;
Cloudflare-to-origin encryption and origin firewall hardening are tracked as
follow-up work rather than being implied by the public HTTPS URL.

## Deploy

From the repository root:

```bash
gcloud auth list
gcloud compute instances describe noos \
  --project=lightsail-migration \
  --zone=us-central1-a \
  --format='value(status)'
bash infra/deploy.sh
curl -fsS https://chat.globalbr.ai/health
```

`infra/deploy.sh` builds the server, legacy web client, and both React Native
web exports before copying the release bundle with `gcloud compute scp`. Its
defaults can be overridden with `GCP_PROJECT`, `GCP_ZONE`, and `GCP_INSTANCE`.
The script uses explicit project and zone flags so an unrelated active gcloud
configuration cannot redirect the deploy.

## Operations

```bash
# Recent application errors
./scripts/check-recent-errors.sh 30m all

# Container state
gcloud compute ssh noos \
  --project=lightsail-migration \
  --zone=us-central1-a \
  --command='sudo docker ps'

# Application logs
gcloud compute ssh noos \
  --project=lightsail-migration \
  --zone=us-central1-a \
  --command='sudo docker logs openchat_app --since 30m'
```

### Trusted user-directory access

`User.canBrowseUserDirectory` is a sparse, server-owned capability. Ordinary
signup, login, identity-bridge, and profile-update requests cannot set it. Grant
it only to people who need to operate a trusted club or mutual-aid directory.

Connect to the production Neo4j shell without putting its password in shell
history or process arguments; `cypher-shell` prompts for it:

```bash
gcloud compute ssh noos \
  --project=lightsail-migration \
  --zone=us-central1-a \
  --command='sudo docker exec -it noos_neo4j cypher-shell -u neo4j'
```

Create the audit identifier constraint once before the first grant or revoke:

```cypher
CREATE CONSTRAINT directory_capability_audit_id IF NOT EXISTS
FOR (a:DirectoryCapabilityAudit) REQUIRE a.id IS UNIQUE;
```

Each operation requires the normalized account email, the operator's durable
identity, and a non-empty reason. Set those parameters, inspect the target, and
grant only when exactly one user matches:

```cypher
:param email => 'trusted-operator@example.com';
:param operator => 'operator@example.com';
:param reason => 'Directory steward for the September mutual-aid intake';
MATCH (u:User) WHERE toLower(u.email) = toLower(trim($email))
RETURN u.id AS id, u.email AS email, coalesce(u.canBrowseUserDirectory, false) AS enabled;

MATCH (u:User) WHERE toLower(u.email) = toLower(trim($email))
WITH collect(u) AS users
WHERE size(users) = 1 AND trim($operator) <> '' AND trim($reason) <> ''
UNWIND users AS u
SET u.canBrowseUserDirectory = true
CREATE (a:DirectoryCapabilityAudit {
  id: randomUUID(),
  targetUserId: u.id,
  targetEmail: toLower(u.email),
  action: 'grant',
  operator: trim($operator),
  reason: trim($reason),
  timestamp: datetime()
})
RETURN u.id AS id, u.email AS email, u.canBrowseUserDirectory AS enabled,
       a.id AS auditId, a.timestamp AS auditedAt;
```

Revoke with the same required parameters, again only when exactly one user
matches:

```cypher
MATCH (u:User) WHERE toLower(u.email) = toLower(trim($email))
WITH collect(u) AS users
WHERE size(users) = 1 AND trim($operator) <> '' AND trim($reason) <> ''
UNWIND users AS u
REMOVE u.canBrowseUserDirectory
CREATE (a:DirectoryCapabilityAudit {
  id: randomUUID(),
  targetUserId: u.id,
  targetEmail: toLower(u.email),
  action: 'revoke',
  operator: trim($operator),
  reason: trim($reason),
  timestamp: datetime()
})
RETURN u.id AS id, u.email AS email,
       coalesce(u.canBrowseUserDirectory, false) AS enabled,
       a.id AS auditId, a.timestamp AS auditedAt;
```

Each query mutates the capability and creates its audit node in one atomic
transaction. Treat `DirectoryCapabilityAudit` as append-only: never update or
delete its nodes. There is no client or API write path for the capability or
its audit history. Inspect history by target email, newest first:

```cypher
:param email => 'trusted-operator@example.com';
MATCH (a:DirectoryCapabilityAudit)
WHERE a.targetEmail = toLower(trim($email))
RETURN a.id, a.targetUserId, a.targetEmail, a.action, a.operator, a.reason,
       a.timestamp
ORDER BY a.timestamp DESC;
```

The change is effective for API authorization immediately. Web and mobile copy
refreshes from `/api/auth/me` on the next authenticated app bootstrap; restart
the client after a grant or revoke to refresh that copy.

Email-bound invitations that resume after TestFlight onboarding, including an
optional authorized directory grant, remain deferred in
[GitHub issue #41](https://github.com/IdeaFlowCo/OpenChat/issues/41) and local
Beads issue `OpenChat-7mv`.

Secrets live in `/opt/openchat/.env` on the GCE instance and must not be copied
into the repository. The live deployment still accepts the legacy `AWS_*`
credential names because the AWS SDK is used as an S3-compatible client for
GCS; provider-neutral `OBJECT_STORAGE_*` names are preferred for new configs.

`JWT_SECRET` remains OpenChat's signing and primary verification key.
`NOOS_JWT_SECRET` is a verify-only compatibility key and must match the Noos API
container's `JWT_SECRET`; it lets fresh Noos sessions authenticate without
invalidating existing OpenChat sessions. Never replace OpenChat's `JWT_SECRET`
with the Noos value as a migration shortcut.

Before deploying this compatibility change to an existing installation, add
`NOOS_JWT_SECRET` to `/opt/openchat/.env`. The deploy script preserves an
existing environment file; its generated template only applies to a new
installation. Confirm both variables are present without printing their values,
then run the normal deploy and verify both an existing OpenChat session and a
fresh Noos session.

## Verified migration status

The public `/api/openapi.json` response exactly matched the response fetched
directly from `34.10.134.247` with the `chat.globalbr.ai` Host header on
2026-08-28. The GCE host was also verified to run the expected OpenChat, Noos,
Neo4j, and nginx containers. Current GCS attachment objects and daily GCE disk
snapshots exist.

Remaining gaps found in that audit:

- The only logical Neo4j export in
  `gs://lightsail-migration-noos-neo4j-backups` is from 2026-07-31. Daily disk
  snapshots are current, but recurring logical database backups are not.
- The attached 10 GB `noos-data` disk is blank and unmounted. Neo4j's 1.1 GB
  data volume is on the 80 GB boot disk, so both daily snapshots protect it,
  but the intended data-disk separation was not completed.
- `boreal-conquest-464203-v2/noos-gcp-1` is an empty duplicate migration VM. It
  is not the production origin and should be removed after an owner confirms
  it has no separate purpose.
- The old Lightsail host is no longer serving production and was unreachable
  during this audit, but AWS account access was not available to confirm that
  its instance, static IP, snapshots, disks, buckets, and billing were removed.
  Treat the traffic cutover as verified and the AWS teardown as unverified.
- The former GCP migration work remained in draft PR #12 and never reached
  `main`; this document and the corrected scripts supersede it.

Current `main` was deployed through the corrected GCP path on 2026-08-28. The
new container passed the public health check, reconnected to Neo4j and the
picortex bot, and `/api/secretary` returned its expected authenticated API
response rather than the previous SPA fallback.

The retired AWS Lightsail address `3.216.129.34` is historical only. Do not use
it for deploys, logs, database access, or health checks.
