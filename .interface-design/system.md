# OpenChat review direction

Jacob's explicit preference, 2026-10-06: “I think I liked warm paper and system sans.” The current dark mode feels too steep in contrast.

- Prefer Warm Paper + System Sans for subsequent OpenChat design reviews. This app-specific preference takes precedence over generic palette defaults.
- Use system-ui / Apple system sans throughout, including headings. Keep the existing warm light palette; no serif headings.
- Start this study in light mode. This does not change the production theme or force a system-wide light-mode preference.
- Dark mode remains optional and under review. Avoid pale outgoing bubbles on nearly black canvases, large surface jumps and glaring text. Soften surfaces while keeping readable foreground contrast.
- The refined prototype palette lives in `.lavish/openchat-sans-themes.html`, `themes.paper.dark`. It is a proposal, not a production token migration.
- Preserve the study's established layout, spacing and component hierarchy; this refinement changes palette/type defaults, not information architecture.
- Consolidated review: https://m4-mini.tailb2a35c.ts.net:4387/session/2ba59de029188897 . Theme review: https://m4-mini.tailb2a35c.ts.net:4387/session/e95411274702490a .
