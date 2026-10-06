# LinkedIn messaging: recommendation

Use **Unipile first for a hosted LinkedIn channel**, with a small provider adapter so it can change later. Keep OpenChat as the shared Unlinked/OpenChat inbox. Plan only; no LinkedIn accounts are connected or messages sent by this release.

| Option | Best fit | Main tradeoff |
| --- | --- | --- |
| **Unipile** | LinkedIn messaging inside Unlinked for multiple users | Hosted provider cost and provider/account restrictions |
| **Beeper Desktop API** | Jacob’s personal, multi-network inbox | Beeper recommends personal use; its desktop app must remain running |
| **Existing Matrix bridges** | A later self-hosted route | We operate sessions, sync and bridge maintenance; Beeper’s older LinkedIn bridge is archived, so establish a maintained route first |
| **Rebuild Beeper** | Only if messaging infrastructure becomes the product | Much larger scope than adding LinkedIn; avoid for this release |

**Proposed experience:** a person’s profile offers **Message** for Unlinked and, after the sender connects LinkedIn, **Message on LinkedIn**. Show the sending account and channel beside Send. Recipients do not need Unlinked to receive a LinkedIn message. Connections, invitations and eligible InMail remain distinct actions; never silently switch channels.

**First implementation:** user-controlled LinkedIn connection via the hosted auth wizard → list existing conversations → reply → start eligible conversations. Resolve a public LinkedIn URL to a provider ID using the connected account, and confirm ambiguous matches. Persist owner + provider + account + chat/message IDs; deduplicate incoming events and reconcile sends before retrying. Keep LinkedIn conversation membership and access separate from shared OpenChat conversations, even when the same person appears in both. Include reconnect, disconnect, deletion and clear delivery failure states.

**Before choosing:** a small opt-in pilot should verify connection/reconnection, history, incoming events, replies, eligible new DMs/InMail, exact pricing and commercial terms. LinkedIn restrictions still apply; this is not blanket permission to message anyone. No bulk outreach in the first slice.

Sources checked 2026-10-05: [Unipile messaging and LinkedIn eligibility](https://developer.unipile.com/docs/send-messages), [account connection methods](https://developer.unipile.com/docs/connect-accounts), [provider limits](https://developer.unipile.com/docs/provider-limits-and-restrictions), [Beeper Desktop API](https://developers.beeper.com/desktop-api/), [Beeper LinkedIn bridge](https://github.com/beeper/linkedin).
