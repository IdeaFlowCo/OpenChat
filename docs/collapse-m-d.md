# Canonical responsive web app

## Resolution — 2026-09-02

OpenChat builds one Expo/React-Native-web product bundle with `baseUrl=/app`
and serves it at `/app`. The old `/m`, `/d`, and `/legacy` routes permanently
redirect to the corresponding `/app` URL while preserving the remaining path
and query string. The frozen `apps/web` source is retained for migration
reference but is no longer built or served.

Layout is selected at runtime, not by URL. `apps/mobile/src/theme/breakpoints.ts`
owns the responsive breakpoint and native tablet guard; the device-local
preference may be `auto`, `compact`, or `split`.

`apps/mobile` owns export commands, `infra/deploy.sh` owns production assembly,
and `apps/server/src/index.ts` owns serving and compatibility redirects. The
Tauri wrapper uses the separate base-path-free `dist-web-shell` export described
in [`apps/desktop/README.md`](../apps/desktop/README.md).

This resolves `openchat-3jq.4`; the pre-resolution options and rollout notes
remain available in git history.
