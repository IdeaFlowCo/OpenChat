# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v54.0.0/ before writing any code.

## Responsive layout (iPad / desktop)

The app is width-responsive, not device-typed. `src/theme/breakpoints.ts`
(`useIsDesktop`, 900px plus a 600px native short-side tablet guard) is the
single source of truth: at desktop/tablet widths `HomeScreen.tsx` renders
`MasterDetailLayout.tsx` (persistent sidebar + conversation pane + keyboard
shortcuts / hover / arrow-key nav where the platform supports them); below it,
the same phone stack is used. Web-only `*.web.tsx` files still need native
sibling shims or Metro fails the native build. iPad landscape is enabled via
`orientation: 'default'` in `app.config.js`. The desktop app is a thin Tauri
wrapper around the RNW export — see `apps/desktop/README.md`; product code stays
here in `src/`.

## Canonical client surface

The repository-root `AGENTS.md` owns the client-surface and deployment contract.
Apply it here: this is the single product client; do not mirror new work into
the frozen `apps/web` source.

- **Platform-appropriate exceptions are fine** (document them): e.g. Enter-to-send is **web-only** (`Platform.OS === 'web'`). On a native touch keyboard the return key stays a newline and sending is the send button. No hardware-keyboard Enter handling needed.
- Pure platform-native experiments are not the current product focus and must
  not block or silently diverge from the Expo/React Native client.
