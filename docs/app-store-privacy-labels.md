# App Store Privacy Labels — OpenChat

> **Audience:** the person filling in App Store Connect → App Privacy.
> **Source of truth:** OpenChat-d8w. Update whenever data collection changes.
> **Last audit:** 2026-07-12 against `apps/mobile/app.config.js` v0.1.23.

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
- **Support URL:** https://chat.globalbr.ai (contact: support@chat.globalbr.ai)
- **App category:** Social Networking (primary), Productivity (secondary)
- **Sign-in providers:** Google OAuth, Sign in with Apple, email/password (via Noos SSO)
- **Server location:** AWS Lightsail (US East), Neo4j Aura, S3-compatible object storage
- **Current App Store blocker:** reviewer account credentials, production seed/demo data, screenshots, and final App Store Connect metadata approval remain human/App Store Connect actions.

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
| Other User Content (chat messages, reactions, reports, feedback, thoughts, status/profile text) | YES | YES | NO | App Functionality, Other Purposes (safety review for reports) |

**Notes:**
- Messages, voice notes, reactions, reports, feedback, thoughts, and image attachments are stored server-side so they sync across devices and can be reviewed when users report safety issues.
- Images live in S3-compatible storage with presigned-URL access.
- We do NOT use this content for advertising, analytics, or model training.
- Bot-routed messages and message transform requests are sent to Anthropic for response generation or rewriting only; voice messages may be sent to OpenAI Whisper for transcription; message text/search queries may be sent to OpenAI for semantic-search embeddings.

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
| Other Usage Data | NO | — | — | — |

**Notes:**
- No third-party analytics SDK (no Firebase, no Mixpanel, no Amplitude).
- We do retain server-side HTTP request logs and `client-logs` (browser-error forward endpoint at `/api/client-logs`) for debugging — these are diagnostic, not behavioral analytics. They include error messages, stack traces, and user agents. See Section 9.

---

## Section 9 — Diagnostics

| Data Type | Collected? | Linked to user? | Used for tracking? | Purposes |
|---|---|---|---|---|
| Crash Data | YES (mobile/web client logger forwards uncaught errors and crash/error context to `/api/client-logs`) | YES when signed in | NO | App Functionality |
| Performance Data | NO | — | — | — |
| Other Diagnostic Data | YES (`/api/client-logs`, server request/error logs) | YES when signed in or present in request context | NO | App Functionality |

**Notes:**
- `/api/client-logs` accepts forwarded web and mobile error events for debugging. Contains error messages, stack traces, request metadata, device/app context, and user agents. Tied to a user only when the event includes signed-in context.
- Sentry is still not shipped; the current crash/error path is OpenChat's own client logger plus server logs.

---

## Section 10 — Third-Party Data Sharing (a.k.a. Data Used to Track You)

**OpenChat does NOT use any data to track you across other companies' apps or websites.** Check "No" on this section.

### Third-party processors we share data with (with purposes):

| Vendor | Data Shared | Purpose |
|---|---|---|
| **Anthropic** (claude-haiku-4-5) | Message content of conversations where an AI agent participates; pre-send transform requests | AI assistant replies, message rewriting |
| **OpenAI** (`text-embedding-3-small`, `whisper-1`) | Message text/search text for embeddings; voice-message audio for transcription | Semantic search, voice-message transcripts |
| **Expo** (push delivery) | Push notification token, conversation ID, message preview | App Functionality (delivering notifications to iOS/Android) |
| **Apple** (Sign in with Apple) | Email (or Apple email-relay), name on first sign-in | Account creation |
| **Google** (OAuth) | Email, name, profile picture; OAuth code exchange | Account creation |
| **AWS** (Lightsail server, S3-compatible storage) | All app data (messages, images, voice notes, profile info) | App Functionality (server infrastructure) |
| **Neo4j Aura** | Account, conversation, message, report, block, and app metadata | App Functionality (database infrastructure) |
| **Noos SSO** (`globalbr.ai`) | Email + password verification | Authentication |
| **World Issue Tracker / Slack webhook tooling** | Feedback, report text, reporter/target metadata, operational error context when configured | Support, safety review, operations |

---

## Reviewer Test Account (REQUIRED for App Review)

App Store Connect → App Information → Notes for Reviewer.

```
Sign in: use the email/password form on the login screen
Reviewer account:
  Email: openchat-reviewer@globalbr.ai
  Password: <TBD — set in 1Password, paste here at submission time>

If Apple asks to verify third-party login parity, Sign in with Apple is available
on iOS from the same login screen. Google sign-in is also available.

The account has all in-app features enabled, including:
  - Voice messages
  - Image attachments
  - AI agent integration via MCP / agent keys in Settings
  - Group chat with 2 seed conversations
  - 3 fixture messages in each thread

Demo data is reset weekly. If you need fresh data, ping
support@chat.globalbr.ai.

ALL communication is end-to-server-encrypted in transit (TLS 1.3) and
stored encrypted at rest. We do NOT do end-to-end encryption between
users — this is a server-side product, similar to iMessage in the Cloud,
WhatsApp Business, or Slack.
```

**ACTION FOR JACOB:**
- [ ] Create `openchat-reviewer@globalbr.ai` via the production email/password sign-up path
- [ ] Generate a strong reviewer password; store in 1Password under "OpenChat App Store Reviewer"
- [ ] Seed the reviewer account with 2 demo conversations + 3 messages each. The current `apps/server/src/seed-test-data.ts` only seeds Alice/Bob test accounts, so either extend it for `openchat-reviewer@globalbr.ai` or create the reviewer demo data manually before submission.
- [ ] Paste the password into App Store Connect → Notes for Reviewer at submission time
- [ ] Confirm the support email `support@chat.globalbr.ai` is monitored (forward to Jacob's primary?)

---

## Privacy Policy URL — required content checklist

The privacy policy at https://chat.globalbr.ai/legal/privacy MUST contain:

- [x] "Data Collected" section listing all of Section 1, 4, 6, 9 above
- [x] "Third-Party Processors" subsection listing all of Section 10 above
- [x] "User Rights" — account deletion path (already shipped: Settings → Delete account)
- [x] "Data Retention" — how long messages are retained, deletion policy
- [x] "International Transfers" — note that data may flow through AWS US-East / Neo4j Aura
- [x] "Contact" — support@chat.globalbr.ai
- [x] Last-updated date

Audited and updated `apps/server/src/legal/privacy.md` on 2026-07-12 for the v0.1.23 launch-readiness pass.

---

## Drift detection — when to re-audit

Re-audit this doc when ANY of these change:

- New data type collected (e.g. contacts, location, health data)
- New third-party processor added (e.g. Mixpanel, Stripe, Twilio)
- New user-content surface added (e.g. video calls would add "Video data")
- Sentry or another third-party crash SDK ships → add that processor and update Section 9 notes
- Phone-number sign-in lands (OpenChat-xf4) → flip Section 1 Phone Number to YES
- Contacts integration lands (OpenChat-ap3) → flip Section 3 Contacts to YES
- Any new third-party SDK added to mobile or web client
