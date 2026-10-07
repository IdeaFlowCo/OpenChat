# Built-in agent source access

OpenChat-a167. Initial scope requested by Jacob: OpenChat, Vision, Unlinked, Noos and World Issue Tracker; no email/calendar integration.

The existing built-in assistant now discovers these five sources. Unlinked resolves the authenticated OpenChat user's stored Ideaflow issuer + subject, provisions a read-only grant through the existing confidential API and searches that account. Explicit revocations are preserved. The obsolete owner-token fallback has been removed, including when server configuration is partially missing.

Vision reads use the ID gateway's separate first-party read broker and the same stored identity. Only read tools are exposed; the Vision adapter's account linkage and note ACLs remain authoritative. Noos search is public-only. Existing World Issue Tracker tools remain available. Failed access is reported separately from empty results, and the agent is instructed to cite actual tool evidence.

Server-only config: `IDEAFLOW_BUILTIN_CLIENT_ID=openchat`, `IDEAFLOW_BUILTIN_CLIENT_SECRET`, `UNLINKED_PROVISION_CLIENT_ID`, `UNLINKED_PROVISION_CLIENT_SECRET`; compose explicitly passes these through. No personal owner credential or downstream signing secret is handed to the model.

Validation: server build/lint and full unit suite; focused per-user identity, revocation, incomplete configuration, cancellation and secret-safe failure tests. Independent review returned go. Live deployment receipts will follow.

The screenshot's separate saved-note extraction failure was fixed and deployed in PR151. The original note's review returned ready with two suggestions, preserved original text and zero applied changes.
