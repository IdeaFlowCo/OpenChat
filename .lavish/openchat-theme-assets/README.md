# OpenChat sans-serif theme study — OpenChat-pqot

Open `../openchat-sans-themes.html` directly, or serve it with Lavish.

This design exploration compares Unlinked indigo, neutral ink, deep green,
and OpenChat's existing warm paper with Public Sans, system sans, DM Sans,
and IBM Plex Sans. It does not modify the product client or production.

Source baseline: OpenChat origin/main `50e2c3d`, especially
`apps/mobile/src/theme/colors.ts`, `palette.ts`, `typography.ts`, and
`components/MasterDetailLayout.tsx`. Public Sans comes from Unlinked's live
outer-page CSS and `mcp-server/private-onboarding-style.mjs`.

The indigo light palette matches the embedded chat. Indigo dark, neutral ink,
and deep green are proposals. Warm paper retains existing standalone colors;
selected-row metadata uses primary text for readable contrast. Sample contacts
and conversations are fictional and all composer activity stays local.

Fonts were downloaded from the Google Fonts CSS service on 2026-10-05 and
bundled locally; corresponding OFL licenses are included. No package dependency
was added or upgraded. System sans uses the viewer's operating-system font.

Browser validation completed:
- All 32 palette/mode/typeface combinations loaded their requested fonts.
- 56 text/background pairs passed 4.5:1; the minimum was 4.94:1.
- Chat search, conversation switching, literal-text local sending, and one
  feedback queue call only on explicit submission were checked.
- Desktop and 390px mobile rendering inspected; no horizontal page overflow.
- JavaScript syntax and local CSS font references checked.
- Tailnet Lavish link returned HTTP 200 from M5.

The responsive HTML is a design study, not the React Native implementation.
Native font integration and device checks belong to the selected product pass.
