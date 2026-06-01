# Decision: defer phone-number sign-in; ship Google-only for now

> **Ticket:** OpenChat-xf4
> **Date:** 2026-06-01
> **Status:** Recommendation written; Neo4j index added as zero-cost prep; awaiting Jacob sign-off then close
> **Owner:** Jacob Cole

## Decision

**Defer.** Stay Google-only (+ Sign in with Apple, already shipped) until ONE of the following triggers fires:

1. We hit **>100 active users** AND data shows contacts-matching as the top growth lever
2. A specific named user is **blocked** from joining because they don't want a Google or Apple account
3. We pivot to a **WhatsApp-style address-book growth loop** (would require this AND OpenChat-ap3)

## Why

### Cost vs benefit at our scale

| Dimension | Today (Google + Apple) | + Phone + OTP |
|---|---|---|
| Onboarding friction | Medium (familiar OAuth) | Low (universal) |
| Cost | $0 | $0.005–$0.04 / SMS (Twilio Verify) |
| Dev / test effort | Easy | 1–2 weeks + ongoing |
| Abuse surface | Low | SIM swap, toll fraud, OTP relay attacks |
| Contacts matching | Useless (email-keyed) | High (phone-keyed) |
| Number portability | Stable | Numbers recycle |
| iOS App Store | Fine | TRIGGERS Sign in with Apple requirement (already have it) |
| Time-to-ship | N/A | 1–2 weeks |

At ~5 users, the SMS cost is negligible BUT the dev effort, abuse hardening, and account-merge UX work is significant. Until contacts-matching becomes strategic (which depends on this AND ap3 shipping), the cost outweighs the benefit.

### If we DO build it (after a trigger fires)

The implementation must include all of:

1. **Twilio Verify** — not raw Programmable SMS. Twilio Verify is purpose-built for OTP: provides built-in rate limits, fraud detection, and toll-fraud protection. Costs more but eliminates the most common abuse vectors.
2. **Sign in with Apple — already shipped** ✅. App Store rule: if you offer a third-party social sign-in (Google), you MUST also offer SIWA. We comply already. Phone sign-in alone does not trigger SIWA; phone *plus Google* does. We're fine.
3. **Account-merge UX BEFORE first SMS goes out** — what happens when a user signs in with Google AND later signs in with a phone number that matches the email's account? Phone signs in to a separate account? Auto-merge? UX needs a real design pass.
4. **Privacy label flip** — `docs/app-store-privacy-labels.md` flips "Phone Number" to YES in Section 1. Privacy policy updates required.
5. **PII handling** — phone numbers are PII at a higher tier than email (linked to physical-world identity, harder to rotate). Server stores normalized E.164 + a sha256 hash for the matching index. Plaintext goes through Twilio (their data processing agreement applies).

## Prep done now (zero-risk, future-proofing)

Adding a Neo4j index on `phoneNumberHash` so that when we DO build it, the contacts-matching query is already indexed for low-latency lookups. Index creation is idempotent and free of cost when the field doesn't exist on any node yet.

```cypher
CREATE INDEX user_phone_hash IF NOT EXISTS FOR (u:User) ON (u.phoneNumberHash);
```

That's the entire low-effort prep — the User node will gain the fields naturally when we ship phone sign-in. Neo4j is schemaless, so no migration is needed.

## Decision triggers

Re-open `xf4` when any of these fires:

- **User count > 100** AND a growth audit identifies "I want to find friends I already have" as the top onboarding friction
- A specific user reports they can't / won't sign in with Google or Apple
- We pivot to a "contacts-driven growth" strategy (would require shipping `ap3` first too)
- App Store review explicitly asks for an additional sign-in method (unlikely — SIWA covers the requirement)

## Action: close `xf4` as "Recommendation: defer; Neo4j index added as zero-risk prep"

Once Jacob signs off, close with this doc as the deliverable.

Companion ticket: **OpenChat-ap3** (expo-contacts) was already deferred pending this decision. Since `xf4` defers, `ap3` stays deferred. Both can close together.
