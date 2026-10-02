# App Store Privacy Labels — OpenChat

> **Audience:** the person filling in App Store Connect → App Privacy.
> **Source of truth:** OpenChat-d8w. Update whenever data collection changes.
> **Disclosure reconciliation:** 2026-09-30 against build108 source (`4b7f136`) and current production provider configuration. This guide does not itself update App Store Connect.

Apple's "App Privacy" section ("nutrition labels") is a structured answer to:
*what does your app collect, and is it linked to the user?* These answers must
**match the live product** — drift triggers App Review rejection and (in worse
cases) public-facing inaccuracy.

The text below maps OpenChat's actual data flows to App Store Connect's
checkbox-style questionnaire. Use the **Data Type → Linked / Purpose** columns
when filling out the ASC form.

---

## Reviewer-facing context

- **Privacy Policy URL:** https://chat.globalbr.ai/legal/privacy
- **Terms of Service URL:** https://chat.globalbr.ai/legal/terms
- **Support URL:** mailto:support@ideaflow.app
- **App category:** Social Networking (primary), Productivity (secondary)
- **Sign-in providers:** Google OAuth, Sign in with Apple, email/password (via Noos SSO)
- **Server location:** Google Cloud Compute Engine (`us-central1`), self-hosted Neo4j

---

## Section 1 — Contact Info

| Data Type | Collected? | Linked to user? | Used for tracking? | Purposes |
|---|---|---|---|---|
| Email address | YES | YES | NO | App Functionality, Account Management |
| Name | YES | YES | NO | App Functionality (display name in chats) |
| Phone Number | NO | — | — | — |
| Physical Address | NO | — | — | — |
| Other User Contact Info | NO | — | — | — |

**Notes:**
- Email + name come from OAuth providers (Google profile, Apple ID name + email-relay or Apple-provided email).
- For private contact names, reconcile the [privacy policy's collection and retention disclosures](../apps/server/src/legal/privacy.md) before a separately authorized release; the build108 reconciliation above predates this feature.
- We do NOT share email with third parties for advertising or analytics.

---

## Section 2 — Health & Fitness, Financial Info, Location, Sensitive Info

- **Health & Fitness:** NONE
- **Financial Info:** NONE
- **Location:** NONE (we do not request `NSLocationWhenInUseUsageDescription` or background location)
- **Sensitive Info:** NONE (no race, religion, sexual orientation, political affiliation, biometric, etc.)

---

## Section 3 — Contacts

| Data Type | Collected? | Linked to user? | Used for tracking? | Purposes |
|---|---|---|---|---|
| Contacts | NO | — | — | — |

**Note:** OpenChat-ap3 explores integrating `expo-contacts` in the future. If/when shipped, this section flips to YES with purpose "App Functionality" (suggest contacts to invite). Privacy label must be re-filed.

---

## Section 4 — User Content

| Data Type | Collected? | Linked to user? | Used for tracking? | Purposes |
|---|---|---|---|---|
| Photos or Videos | YES (image attachments) | YES | NO | App Functionality |
| Audio Data (voice messages) | YES | YES | NO | App Functionality |
| Other User Content (chat messages, reactions) | YES | YES | NO | App Functionality |

**Notes:**
- Message records, transcripts, reactions and attachment references are stored in Neo4j so they sync across devices. Uploaded image/audio files live in the configured object storage.
- For voice-transcription processors and purposes, including in human-only chats, see Section 10.
- We do NOT use this content for advertising, analytics, or model training.
- For AI-assistant and pre-send transform processing, see Section 10.

---

## Section 5 — Browsing History, Search History

- **Browsing History:** NONE
- **Search History:** Users can search their own message history client-side; nothing is logged server-side beyond standard request logs.

---

## Section 6 — Identifiers

| Data Type | Collected? | Linked to user? | Used for tracking? | Purposes |
|---|---|---|---|---|
| User ID (internal nanoid) | YES | YES | NO | App Functionality |
| Device ID | NO | — | — | — |
| Push Notification Token (Expo) | YES | YES | NO | App Functionality (delivering push) |

**Notes:**
- User IDs are internal nanoid strings, generated server-side on first sign-in.
- Expo push tokens are stored against the user record so server can fan out notifications.
- No advertising identifiers (IDFA), no cross-app device fingerprinting.

---

## Section 7 — Purchases

- **Purchase History:** NONE (OpenChat is free; no IAP)

---

## Section 8 — Usage Data

| Data Type | Collected? | Linked to user? | Used for tracking? | Purposes |
|---|---|---|---|---|
| Product Interaction (analytics events) | NO | — | — | — |
| Advertising Data | NO | — | — | — |
| Other Usage Data (presence / last activity) | YES | YES | NO | App Functionality (presence) |

**Notes:**
- No third-party behavioral analytics SDK (no Firebase, no Mixpanel, no Amplitude). Online/offline presence and last-activity timestamps are collected for the chat experience.
- For diagnostic collection and its classification, see Section 9.

---

## Section 9 — Diagnostics

| Data Type | Collected? | Linked to user? | Used for tracking? | Purposes |
|---|---|---|---|---|
| Crash Data (fatal uncaught-error reports) | YES | YES (conservative; see notes) | NO | App Functionality (debugging) |
| Performance Data | NO | — | — | — |
| Other Diagnostic Data | YES (`/api/client-logs` mobile/web errors and warnings) | YES (conservative; see notes) | NO | App Functionality (debugging) |

**Notes:**
- `apps/mobile/src/services/clientLogger.ts` installs global fatal-error and unhandled-rejection handlers and sends diagnostic reports to `/api/client-logs`, including message/stack, supplied context, platform and app version. The server records IP address and user agent. Fatal-error collection exists even while the optional Sentry scaffold is disabled.
- The log endpoint does not require sign-in or automatically attach a user ID. Do not infer that logs are anonymous: request metadata or supplied context can link them to a person. Keep the conservative linked-to-user classification until the release owner verifies the actual envelopes and any anonymization guarantees.
- Reconcile Crash Data and Other Diagnostic Data in ASC with this custom collector. Do not wait for Sentry to declare crash collection. Any future Sentry enablement requires a separate processor and data-flow review.

---

## Section 10 — Third-Party Data Sharing (a.k.a. Data Used to Track You)

**OpenChat does NOT use any data to track you across other companies' apps or websites.** Check "No" on this section.

### Third-party processors we share data with (with purposes):

| Vendor | Data Shared | Purpose |
|---|---|---|
| **Anthropic** (claude-haiku-4-5) | Message content of conversations where an AI agent participates; pre-send transform requests | AI assistant replies, message rewriting |
| **Deepgram** (voice transcription) | Uploaded voice-message audio | App Functionality (generating transcripts, including in human-only chats) |
| **OpenAI** (Whisper fallback) | Uploaded voice-message audio when the primary transcription path does not return text | App Functionality (generating transcripts) |
| **Expo** (push delivery) | Push notification token, conversation ID, message preview | App Functionality (delivering notifications to iOS/Android) |
| **Apple** (Sign in with Apple) | Email (or Apple email-relay), name on first sign-in | Account creation |
| **Google** (OAuth) | Email, name, profile picture; OAuth code exchange | Account creation |
| **Google Cloud** (Compute Engine and Cloud Storage) | All app data (messages, images, voice notes, profile info) | App Functionality (server infrastructure) |
| **Noos SSO** (`globalbr.ai`) | Email + password verification | Authentication |

---

## Reviewer Test Account (REQUIRED for App Review)

The reviewer credentials and sign-in instructions are owned by App Store
Connect → App Information → Notes for Reviewer. Use that existing account;
do not create or reseed an account from a documentation template. Before a
separately authorized submission, verify those exact credentials and the
available synthetic conversations, and confirm the support email is monitored.

---

## Privacy Policy URL — required content checklist

The privacy policy at https://chat.globalbr.ai/legal/privacy MUST contain:

- [ ] "Data Collected" section listing all of Section 1, 4, 6, 9 above
- [ ] "Third-Party Processors" subsection listing all of Section 10 above
- [ ] "User Rights" — account deletion path (already shipped: Settings → Delete account)
- [ ] "Data Retention" — how long messages are retained, deletion policy
- [ ] "International Transfers" — note that data may flow through Google Cloud US regions
- [ ] "Contact" — support@ideaflow.app
- [ ] Last-updated date

Audit the authoritative [privacy policy source](../apps/server/src/legal/privacy.md) against these requirements before a separately authorized submission. Storage and deletion behavior are documented there; this checklist does not establish release readiness.

---

## Drift detection — when to re-audit

Re-audit this doc when ANY of these change:

- New data type collected (e.g. contacts, location, health data)
- New third-party processor added (e.g. Mixpanel, Stripe, Twilio)
- New user-content surface added (e.g. video calls would add "Video data")
- Changes to the existing custom crash logger, or Sentry enablement → recheck Section 9 and processor disclosures
- Phone-number sign-in lands (OpenChat-xf4) → flip Section 1 Phone Number to YES
- Contacts integration lands (OpenChat-ap3) → flip Section 3 Contacts to YES
- Any new third-party SDK added to mobile or web client
