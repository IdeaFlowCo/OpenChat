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

Secrets live in `/opt/openchat/.env` on the GCE instance and must not be copied
into the repository. The live deployment still accepts the legacy `AWS_*`
credential names because the AWS SDK is used as an S3-compatible client for
GCS; provider-neutral `OBJECT_STORAGE_*` names are preferred for new configs.

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
