# Profile capture and page-aware agent review

Jacob's 6 October 2026 direction combines rough-note capture on a person with one agent available across app surfaces. This review adds the profile entry points and illustrates the intended context behavior. It uses the selected Warm Paper + System Sans direction.

- Current profile: https://m4-mini.tailb2a35c.ts.net:4387/session/4a9912350363711a
- Matching standing-ask review: https://m4-mini.tailb2a35c.ts.net:4387/session/0daebd00c2eb03d8
- Beads prototype: OpenChat-3lre. Production capture follow-up: OpenChat-a0e.7. Broader personal agent architecture: OpenChat-0a4.
- Durable snapshots: `.lavish/openchat-profile-current-review.html` and `.lavish/openchat-person-asks-v1.html`; historical reviews remain adjacent under `.lavish/profile-review-history/`.
- Live Lavish sessions read the matching files in `/Users/jacob/code/tmpworkspace/.lavish/`. Keep those and these snapshots aligned when editing.

## Behavior to review

Save note keeps the original wording privately in the preview. Save & review updates opens the same agent panel as the navigation entry, showing the current person and visibility scope. The Chet example recognizes the existing ask and Mentioned connection, and proposes Seeking connections in: Sacramento. Selected updates retain the source note and can be undone without deleting that note. Duplicate records are skipped. Changing people resets agent context; Hide private excludes private asks and connections from the summary.

The prototype is not connected to a model or a production graph. It uses a known example and explicit `Relation: target` / `Ask: text` lines to illustrate extraction; arbitrary prose is retained without guessed facts. Changes reset on reload. Other app surfaces still need the consistent agent entry and server-enforced context permissions. No invitations, graph mutations, or messages are sent.

## Real data and provenance

- Chet person record: https://globalbr.ai/node/yRQ87NFQf5CCFhnFK40D8 . A verified OpenChat account binding is not recorded.
- Standing ask: https://globalbr.ai/node/KmGyR378RU9RWb8oRDCYC . Verified directly with `noos show` via M5 during this task. Exact wording: “Find cool people to hang out with in Sacramento.” Recorded by Jacob on 6 October 2026, active and ongoing, private friend-CRM context. It does not establish Chet's home location or permission to publish on his behalf.
- Conversation-context note: https://vision.ideaflow.app/n/01a1134e-d591-77bb-bb49-21217f222d29 . Title and saved link recovered from the 6 October conversation. It records exe.dev as a cool project from a chat with Chet; no original transcript was found. Use Mentioned, not Recommended, employment or authorship.
- Other people and sample asks are explicitly illustrative.

## Validation

Browser interaction checks passed for note-before-proposal saving, duplicate detection, selected application, undo retaining the note, exact-note deduplication, explicit-label extraction, person switching and hidden-private context. Desktop and mobile showed no horizontal overflow; the native dialog fit the viewport and received focus. JavaScript passed `node --check`. Both live artifacts are byte-identical. The Lavish session was verified reachable from M5 (HTTP 200).
