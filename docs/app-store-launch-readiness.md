# OpenChat App Store Launch Readiness

Last audited: 2026-07-12 for `apps/mobile/app.config.js` v0.1.23 and bundle id `com.jacobcole.openchat`.

This checklist is for the first public Apple App Store submission. It is separate from TestFlight release operations in `docs/testers.md`.

## Ready In Code

- Sign in with Apple is present on iOS and backed by `POST /api/auth/apple/idtoken-exchange`.
- Google sign-in and email/password sign-in are available from the login screen.
- Account deletion is available from Settings and backed by `DELETE /api/auth/me`.
- Data export is available for account and conversation data.
- User-generated content controls are present: report message, report user, block user, unblock from Settings, and server-side report storage/webhook notification.
- AI disclosure is present for conversations containing bot users.
- Legal links are exposed from Settings and served at `https://chat.globalbr.ai/legal/privacy` and `https://chat.globalbr.ai/legal/terms`.
- Native permissions are explained in `app.config.js`: camera for QR scanning, photo library for image sharing, microphone for voice messages, remote notification background mode for push.
- TestFlight/native release scripts and EAS submit configuration exist in `apps/mobile/scripts/local-build.sh` and `apps/mobile/eas.json`.

## Human/App Store Connect Blockers

- Create and verify the reviewer account `openchat-reviewer@globalbr.ai` in production.
- Seed reviewer-visible demo data. The current `apps/server/src/seed-test-data.ts` only targets Alice/Bob test accounts, so reviewer data must be created manually or the script must be extended before submission.
- Store the reviewer password in 1Password and paste it only into App Store Connect Review Notes at submission time.
- Confirm `support@chat.globalbr.ai` is monitored.
- Prepare App Store screenshots for required iPhone sizes. No screenshot set was found in the repo during this audit.
- Fill App Store Connect metadata: app description, keywords, support URL, marketing URL if desired, copyright, age rating, category, review notes, privacy labels, and version release notes.
- Confirm the production backend at `https://chat.globalbr.ai` is live, healthy, and using production env vars for Google, Apple, Anthropic/OpenAI features, push, reports, and feedback.
- Obtain explicit approval before submitting for App Review.

## Recommended Review Notes

Paste only after the reviewer account exists and has demo data:

```text
OpenChat is a messaging app with optional AI assistant features.

Demo account:
Email: openchat-reviewer@globalbr.ai
Password: <paste from 1Password at submission time>

Sign in with the email/password form on the login screen. Sign in with Apple is also available on iOS and Google sign-in is available as a third-party login option.

Demo coverage:
- Direct and group chats with seeded messages
- Image attachments and voice messages
- Report/block flows from message actions and user profiles
- Account deletion in Settings -> Legal & Account -> Delete my account
- Privacy Policy and Terms links in Settings
- AI assistant disclosure appears in conversations that include a bot user

Backend services are live at https://chat.globalbr.ai. The app requires network access for sign-in, messaging, push registration, attachments, and AI features.
```

## Submission Commands

Do not run these until screenshots, reviewer credentials, App Store Connect metadata, and final approval are complete.

Web/server/RN-web deploy:

```bash
cd /Users/jacobcole/.treehouse/OpenChat-a02908/1/OpenChat
bash infra/deploy.sh
```

Native iOS build, TestFlight submit, and tester publication:

```bash
cd /Users/jacobcole/.treehouse/OpenChat-a02908/1/OpenChat/apps/mobile
TMPDIR="$HOME/.ocbuild-tmp" bash scripts/local-build.sh
```

Local build constraints:

- Do not run `scripts/local-build.sh` under tmux.
- Use Node 22.
- Expect the script to bump the app version, commit, push, build locally, submit to App Store Connect, and publish to the configured TestFlight testers.

## App Review Readiness Verdict

OpenChat is not ready for App Review submission until the human/App Store Connect blockers above are cleared. The minimum blocker list is:

1. Reviewer account exists, credentials are available in App Store Connect Review Notes, and demo data is seeded.
2. App Store screenshots and metadata are complete.
3. Privacy labels are entered in App Store Connect from `docs/app-store-privacy-labels.md`.
4. Production backend and legal URLs are verified live.
5. Explicit approval is given to submit for App Review.
