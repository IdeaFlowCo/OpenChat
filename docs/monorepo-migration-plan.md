# OpenChat Migration Inventory & Assessment

## Goal: One Codebase via `react-native-web`

As established, `react-native-web` is the target direction for OpenChat. The `apps/mobile` directory is already an Expo/React Native application that builds for iOS and outputs a web bundle.

The `apps/web` application is **frozen and no longer served**, replaced by the `react-native-web` build of `apps/mobile` served at `/app`.

This document assesses the work required to fully port the remaining features from `apps/web` into the unified `apps/mobile` codebase and deprecate `apps/web` completely.

### 1. API Client (`api.ts` vs `api/client.ts`)
- **Status:** Diverged.
- **apps/web (`src/api.ts`):** 1,293 lines. Defines a unified `ApiClient` class with ~65 async methods.
- **apps/mobile (`src/api/client.ts`):** 1,573 lines. Defines exported API methods directly, using a custom wrapper (`request`).
- **Migration Path:** `apps/mobile` is the canonical client. The `apps/web` `ApiClient` class should be abandoned. Any missing API methods in `apps/mobile` (if any exist) must be ported.
- **Risk:** Low.

### 2. Auth Handling
- **Status:** Diverged.
- **apps/web:** Uses `localStorage` and `sessionStorage` directly (`utils/authSession.ts`).
- **apps/mobile:** Uses Expo SecureStore with AsyncStorage fallback, handling device keychain encryption appropriately (`SECURE_TOKEN_KEY`).
- **Migration Path:** Rely entirely on the Expo `SecureStore` (with web polyfill built-in via `expo-secure-store`) in `apps/mobile`. `apps/web` auth code is strictly legacy DOM-dependent.
- **Risk:** Low. Web auth flow is already handled by `apps/mobile/src/screens/LoginScreen.tsx`.

### 3. Socket / Realtime (`hooks/useChatSocket.ts` vs `api/socket.ts`)
- **Status:** Diverged.
- **apps/web:** Uses a custom `useChatSocket` React hook (294 lines) wrapping `socket.io-client`.
- **apps/mobile:** Uses a decoupled functional API module `api/socket.ts` (130 lines) relying on `socket.io-client`.
- **Migration Path:** Retain `apps/mobile/src/api/socket.ts` which uses an event-driven architecture that functions decoupled from React's render loop, necessary for background messaging on mobile.
- **Risk:** Low. The `apps/mobile` socket layer handles disconnects and reconnects better for mobile lifecycles.

### 4. Message Rendering (`MessageContent`, `VoiceMessageBubble`, etc.)
- **Status:** Fully Duplicated.
- **apps/web:** Implements rendering via React + TailwindCSS + plain HTML (`<div>`, `<span>`).
- **apps/mobile:** Implements rendering via React Native (`<View>`, `<Text>`) using a custom token theme system.
- **Migration Path:** The `apps/web` components must be completely abandoned. `react-native-web` correctly translates `<View>` and `<Text>` to DOM elements. `apps/mobile`'s theme token system must remain the single source of truth.
- **Risk:** Medium. Moving any missing complex web layouts to Flexbox-only RN layouts requires care, but the core layout of `apps/mobile` already functions correctly via `/app`.

### 5. Conversation State (`ChatContext.tsx`)
- **Status:** Diverged.
- **apps/web (`contexts/ChatContext.tsx`):** 1,008 lines.
- **apps/mobile (`contexts/ChatContext.tsx` & `contexts/conversationState.ts`):** 1,155 + 51 lines. Uses different pagination shapes (e.g., `{ messages, hasMore }` vs raw arrays).
- **Migration Path:** `apps/mobile` `ChatContext` is the survivor. It handles native pagination and infinite scroll effectively.
- **Risk:** Low.

## Conclusion

The path to a single codebase via `react-native-web` is highly viable and largely complete structurally. `apps/mobile` already functions as the singular product client for both native and web (`/app`), while `apps/desktop` acts as a thin shell around it. 

**Rough Size of Remaining Work:** Small. It is primarily an audit to ensure no edge-case web features were left behind in the frozen `apps/web` before completely removing the `apps/web` directory.

**Main Risks:** Feature parity gaps (e.g. keyboard shortcuts, specific DOM-only drag-and-drop affordances) from `apps/web` that haven't been re-implemented in React Native for the `/app` bundle.

**Next Steps:**
1. Audit the `apps/web` directory against `apps/mobile` to ensure no critical features are missing.
2. Delete the `apps/web` directory entirely to remove confusion and prevent accidental updates to dead code.
