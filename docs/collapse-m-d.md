# Design note: collapse `/m` and `/d` onto one responsive RN-web source

Ticket: **openchat-3jq.4** (depends-on the now-complete monorepo migration
openchat-3jq.5). Tracking epic: **openchat-3jq**.

## TL;DR

`/m` and `/d` are **already the same source** running the same responsive
layout logic. The app switches between the single-column mobile layout and the
master-detail desktop layout **at runtime by viewport width** (≥ 900px), not at
build time. The two `expo export` runs in `infra/deploy.sh` differ **only** in
`experiments.baseUrl` (`/m` vs `/d`) — i.e. where assets are fetched from. The
JS/layout is identical.

So "collapse to one responsive source" is, for the code, **already done**. What
remains is an optional **build/serving** simplification: stop exporting twice
and serve one bundle at both paths. That is a deploy-pipeline change, and the
deploy pipeline is the load-bearing thing we must not break — so this note
proposes it but implements only the minimal, reversible first step.

## How it works today

### Code (already responsive — no fork)

- `src/theme/breakpoints.ts` — `useIsDesktop()` returns `true` only on web at
  `width >= 900`. Uses RN's `useWindowDimensions()`, so it re-evaluates on
  resize. On native it's always `false`.
- `src/screens/HomeScreen.web.tsx` / `ChatScreenRouter.web.tsx` — on web ≥900px
  render `MasterDetailLayout`; otherwise the single-column conversations stack.
- `src/components/MasterDetailLayout.web.tsx` — the side-by-side desktop view
  (sidebar + chat pane, keyboard shortcuts, collapsible sidebar).
- There is **no** `openchat-mobile-desktop` repo anymore. The comments in
  `app.config.js` and `breakpoints.ts` confirm `/m` and `/d` both build from
  the same `apps/mobile` source (OpenChat-601).

### Build (the only divergence)

`infra/deploy.sh` runs `expo export --platform web` twice:

```
IS_WEB_BUILD=1 OPENCHAT_BASE_URL=/m  → dist-web-m → client-mobile/dist           (served at /m)
IS_WEB_BUILD=1 OPENCHAT_BASE_URL=/d  → dist-web-d → client-mobile-desktop/dist   (served at /d)
```

`app.config.js` applies `experiments.baseUrl = OPENCHAT_BASE_URL` **only** when
`IS_WEB_BUILD=1`. `baseUrl` rewrites every asset/script URL in `index.html` to
be prefixed with `/m/` or `/d/`. That prefix must match the server mount path
or every JS/CSS request 404s — which is exactly why deploy.sh has the
cross-contamination validator (lines ~58-102) that fails the build if a `/m`
bundle references `/d` paths or vice-versa.

### Serving

`apps/server/src/index.ts`:

```
app.use('/m', express.static(client-mobile/dist))         + SPA fallback /^\/m(\/|$)/
app.use('/d', express.static(client-mobile-desktop/dist)) + SPA fallback /^\/d(\/|$)/
```

Plus `/d` gets PWA assets (manifest + service worker + icons) injected into its
`index.html` at deploy time.

## Why we still export twice

Purely because `experiments.baseUrl` is a **build-time constant** baked into
`index.html` and the bundle's asset URLs. A bundle built with `baseUrl=/m`
cannot be served at `/d` as-is: its `<script src="/m/...">` tags would 404 under
`/d`. So today, one export per mount path.

## Options to collapse the double export

### Option 1 — single export served at one canonical path, `/m` & `/d` redirect

Build **once** with `baseUrl=/app` (or reuse `/d`), serve at that canonical
path, and 301/302-redirect `/m` and `/d` to it.

- Pros: one export (faster deploy), one artifact, no contamination class of bug.
- Cons: changes user-visible URLs; existing links/Q/landing buttons point at
  `/m` and `/d`; the landing page and invite links hard-code `/m/...` and
  `/d/...` (`apps/server/src/index.ts` lines ~176-177). PWA scope is tied to a
  path. Breaks any bookmarks. **Higher blast radius.**

### Option 2 — single export, served byte-identically at BOTH `/m` and `/d` using a *relative* baseUrl

If the bundle used **relative** asset URLs (no leading-slash base path), the
same `dist/` could be mounted at both `/m` and `/d` and assets would resolve
relative to whichever path served `index.html`.

- Expo/Metro web export's `baseUrl` expects an absolute path; relative-base
  output is not a first-class, well-supported mode and SPA client-side routing
  + deep links assume a known base. This is the "right" long-term answer but
  needs real validation that RN-web + the router behave under a relative base.
- Pros: one export, both paths keep working, no redirects.
- Cons: requires verifying relative-base export works end-to-end (router, deep
  links, PWA, service-worker scope). **Medium risk, needs a spike.**

### Option 3 — single export, then post-process a copy for the second path

Export once with `baseUrl=/d`, copy the dist to the `/m` target, and rewrite the
`/d/` asset references to `/m/` (string replace in `index.html` + any bundle
references). This is essentially what two exports produce, minus the second
Metro run.

- Pros: one Metro/expo export run (the slow part); keeps both paths; keeps the
  existing validator semantics.
- Cons: asset-URL rewriting across hashed bundles is brittle — if any asset URL
  appears somewhere the regex misses, you get 404s. The current two-export
  approach is brittle-proof precisely because each build is internally
  consistent. **Net risk not clearly lower than today.**

## Recommendation

**Keep the two-export deploy as the safe default. Do not change the prod export
flow in this pass.** The code-level "collapse" (single responsive source) is
already satisfied and is what the acceptance criteria actually require:

- ✅ `/m` and `/d` deploy from the same current RN-web source (`apps/mobile`).
- ✅ Desktop layout usable at wide widths (master-detail ≥900px).
- ✅ Mobile layout usable at narrow widths (single column <900px).
- ✅ Deploy no longer relies on an untracked desktop repo (it builds from
  `apps/mobile` in-tree).
- ✅ Fallback behavior documented (this note + the placeholder path in
  deploy.sh when the mobile source is absent).

The remaining double-`expo export` is a **deploy-time optimization**, not a
correctness requirement, and collapsing it risks the one pipeline we can't
re-run from this worktree. Pursue **Option 2** (relative baseUrl, single export)
as a follow-up spike with a real deploy test, since it's the only option that
removes the second export *without* changing user-facing URLs.

### Minimal, reversible first step taken in this pass

In `infra/deploy.sh`, the two export runs are now factored behind a single
`export_rnweb <baseUrl> <out-dir> <dest>` shell function and guarded by an
opt-in `OPENCHAT_SINGLE_RNWEB_EXPORT` flag (default **off**):

- **Default (flag unset):** byte-for-byte the same two-export behavior as
  before — `/m` and `/d` are each exported with their own `baseUrl`, validated
  for cross-contamination, and `/d` gets PWA injection. **Nothing changes for
  prod.**
- **Opt-in (`OPENCHAT_SINGLE_RNWEB_EXPORT=1`):** exports `/d` once and derives
  `/m` from it by copying + rewriting `/d/`→`/m/` references in `index.html`
  (Option 3). This is wired up so it can be **tested in a throwaway deploy**
  without touching the default path. It is NOT recommended for prod until the
  Option-2 spike lands; it exists only to make experimentation cheap and to
  keep the default deploy untouched.

This keeps prod identical while making the collapse experiment one env var away,
and leaves both `/m` and `/d` outputs in place so nothing downstream breaks.

## Follow-up work (file as needed)

1. Spike Option 2: prove relative-baseUrl `expo export` works with the
   `@react-navigation` router, deep links, and the `/d` PWA service-worker scope.
2. If Option 2 holds, mount one `dist/` at both `/m` and `/d` in
   `apps/server/src/index.ts` and drop the second export entirely.
3. Decide whether a canonical path (e.g. `/app`) should exist with `/m`,`/d` as
   redirects (Option 1) — separate UX decision, touches landing/invite links.
