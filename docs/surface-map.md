# OpenChat Client Surface Map

Every screen in `apps/mobile` (the canonical served client), its organizing noun, its front doors from cold open, and its one canonical visible label.

> **Rule for new screens:** Every new screen or feature adds a row to this map in the same PR.
>
> **The Front-Door Test:** From the Chats screen, every feature must be reachable in at most two taps. Every tap must have a visible word (not only an accessibility label / icon glyph), and the word must be the one a user would search for.

---

## Surface Map

| Screen | Noun | Canonical Visible Label | Front Doors from Chats | Taps from Chats | Notes |
|---|---|---|---|:---:|---|
| `MyCard` | Me | **Profile** (shareable section: **My card**) | 1. Tapping own avatar (phone Chats header left, desktop sidebar top)<br>2. Settings › Contacts › My card | 1 | The single "Me" surface. Contains card QR, "Scan a code" button, Edit profile row, OpenChat Agent row, and Settings row. |
| `ProfileEdit` | Me | **Edit profile** | 1. Profile › Header row (tap photo/name)<br>2. Profile › "Edit profile" row<br>3. Settings › Account › Edit profile<br>4. Self-DM chat header tap | 2 | Profile photo, display name, headline, status message, and directory visibility. |
| `Conversations` | Chats | **Chats** | Bottom tab "Chats"; desktop sidebar | 0 | Home screen. Pinned OpenChat Agent row sits at top of conversation list. Header has avatar, search, and +. |
| `Chat` | Chats | **Chat** (Header: participant / group / bot name) | 1. Tapping any conversation row in Chats<br>2. Profile › OpenChat Agent row<br>3. New Chat recipient selection | 1 | Message thread, composer, voice memo, media attachments, and conversation options. |
| `NewConversation` | People | **New Chat** | Chats header "+" button; desktop sidebar "+" (⌘N) | 1 | Top row has "Scan a code". Below: Direct Message / Group toggle, search / directory list. |
| `ScanQr` | People / Me | **Scan a code** | 1. Profile › "Scan a code" button (under QR)<br>2. New Chat › "Scan a code" top row<br>3. Settings › Contacts › Scan QR | 2 | Camera barcode scanner for AddMe cards and group invites. Graceful message on web. |
| `ContactProfile` | People | **Contact Info** (Participant name) | In-chat header tap; group participant list tap | 2 | View other user's public card, presence, and chat actions. |
| `AgentOverlay` | OpenChat Agent | **OpenChat Agent** | 1. Profile › "OpenChat Agent" row<br>2. In-chat overflow menu › "OpenChat Agent"<br>3. Asks tab › "Tell OpenChat Agent"<br>4. Story viewer › "Ask OpenChat Agent"<br>5. Desktop sidebar footer robot button | 2 | Dedicated agent interface. Also reachable directly as a pinned chat row in Chats. |
| `AsksList` | Asks | **Asks** | Bottom tab "Asks" (enhanced experience mode) | 1 | Peer coordination, asks, offers, and match opportunities. Gated on enhanced mode. |
| `StoryComposer` | Asks | **Share a Story** | Asks screen › "Share a Story"; Stories rail "+" button | 2 | Publish 24h stories and requests to network. |
| `StoryViewer` | Asks | **Story** (Header: Author name) | Stories rail avatar tap | 1 | View network story, reply directly, or ask OpenChat Agent about it. |
| `SocialReview` | Asks | **Review** | Asks screen › "Review" card; AgentOverlay Review card | 2 | Review and approve/decline quiet match opportunities. |
| `Thoughts` | Thoughts | **Thoughts** | Bottom tab "Thoughts"; in-chat menu "Thoughts for this chat" | 1 | Private notes, ideas, and semantic search. |
| `Settings` | Settings | **Settings** | 1. Profile › "Settings" row<br>2. Desktop shortcut (⌘,) | 2 | Account, experience mode, agent keys, theme, notifications, and legal info. |
| `Search` | Search | **Search** | Chats header magnifying glass; desktop shortcut (⌘K) | 1 | Search conversations and messages. |
| `BlockedUsers` | Settings | **Blocked users** | Settings › Legal & Account › Blocked users | 3 | Manage blocked contacts. |
| `GroupSettings` | Chats | **Group Info** | In-chat header tap on a group conversation | 2 | Group member roster, rename, add/remove participants. |

---

## Architectural Principles

1. **Doors hang from nouns, not feature builders.** Features are filed under user concepts (Me, People, Chats, Asks, Thoughts, Settings), not under whichever team or PR introduced them.
2. **Avatar is "Me".** The user's face in the chrome is the single entry point to everything about themselves (their card, their QR code, scanning others' codes, profile editing, agent, settings).
3. **OpenChat Agent is always an ordinary chat.** The assistant conversation is created server-side upon sign-in and pinned in Chats. The agent noun is never hidden behind `enhanced` mode; only the coordination layer (Asks, Stories, Review, quiet matching) is gated.
4. **Reciprocal actions live together.** "Show my QR code" and "Scan their code" belong on the same surface (`Profile`), with "Scan a code" directly beneath the user's code.
