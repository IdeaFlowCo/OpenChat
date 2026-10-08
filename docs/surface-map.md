# OpenChat Client Surface Map

Every screen in `apps/mobile` (the canonical served client), its organizing noun, its front doors from cold open, and its one canonical visible label.

> **Rule for new screens:** Every new screen or feature adds a row to this map in the same PR.
>
> **The Front-Door Test:** From the Chats screen, every feature must be reachable in at most two taps. Every tap must have a visible word (not only an accessibility label / icon glyph), and the word must be the one a user would search for.

---

## Surface Map

| Screen | Noun | Canonical Visible Label | Front Doors from Chats | Taps from Chats | Notes |
|---|---|---|---|:---:|---|
| `Login` | Account | **Sign in with Ideaflow** on web, iOS and Android (the only control, plus **Sign in with Apple** on iOS until Ideaflow ID offers Apple; legacy methods only when the server disables Ideaflow) | Cold open while signed out | — | Web shows only the Ideaflow ID button when the server enables it; the first sign-in after an explicit sign-out asks which account; see [Ideaflow web sign-in surface](./ideaflow-id-migration.md#web-sign-in-surface-you-sign-in-with-ideaflow) and [native sign-in](./ideaflow-id-migration.md#native-sign-in-ios-and-android-code-xbh14). Pre-login release label and Google sign-in feedback; see [sign-in and release reporting](../apps/mobile/README.md#google-sign-in-and-release-reporting). |
| `PasswordRecoveryHelp` | Account | **Forgot password?** | Signed-out Login › Forgot password? | — | See [password recovery help](../apps/mobile/README.md#password-recovery-entry). |
| `MyCard` | Me | **Profile** (shareable section: **My card**) | 1. Phone: tapping own avatar (Chats header left)<br>2. Desktop: sidebar avatar › account menu › **Profile**<br>3. Settings › Contacts › My card | 1 (phone) / 2 (desktop) | Card QR, public-card preview and field controls, share link, WhatsApp handoff, scanning, profile settings, and **Account › Sign out**. The identity header and the Profile/Settings/Sign out menu render even if the card request fails. |
| `ProfileEdit` | Me | **Edit profile** | 1. Profile › Header row (tap photo/name)<br>2. Profile › "Edit profile" row<br>3. Settings › Account › Edit profile<br>4. Self-DM chat header tap | 2 | Profile photo, display name, headline, status message, and directory visibility. |
| `Conversations` | Chats | **Chats** | Bottom tab "Chats"; desktop sidebar | 0 | Home screen. Pinned OpenChat Agent row sits at top of conversation list. Visible Friends, Requests, and Find people doors sit above chats. |
| `Chat` | Chats | **Chat** (Header: participant / group / bot name) | 1. Tapping any conversation row in Chats<br>2. Profile › OpenChat Agent row<br>3. New Chat recipient selection | 1 | Message thread, composer, voice memo, media attachments, and conversation options. |
| `Chat` message links | Chats | **URL text**, **More**, **Links · Open or copy** | Chats › conversation › underlined URL | 2 | HTTP/HTTPS and www links open directly. Message More › Links provides labeled Open link / Copy link actions; native long press and browser selection/context menus are preserved. See [message links](message-links.md). |
| `Chat` history recovery | Chats | **Retry** | Chats › conversation row › Retry (after a load error) | 2 | See [message-loading recovery](../README.md#messages-and-stream). |
| `NewConversation` | Chats | **New message** | Chats header and desktop sidebar compose icon + "New message" (⌘N) | 1 | Top rows have "Invite a person" and "Scan a code". Below: Direct Message / Group toggle, search / directory list. |
| `InvitePerson` | People | **Invite a person** | Chats › New message › Invite a person | 2 | Single-contact native picker with optional Contacts access; invitation preview, share sheet, WhatsApp draft, and copy link. Browser uses manual sharing. No contact matching or automatic send. |
| `Friends` | People | **Friends** / **Requests** | Chats › "Friends" or "Requests" visible row | 1 | Accepted friends, received/sent requests, Find people, and Scan a code. Acceptance offers Message without sending a greeting. |
| `ScanQr` | People / Me | **Scan a code** | 1. Profile › "Scan a code" button (under QR)<br>2. New message › "Scan a code" top row<br>3. Settings › Contacts › Scan QR | 2 | Native and browser scanner; see [card scanning usage and fallbacks](../apps/mobile/README.md#scan-an-openchat-card). |
| `ContactProfile` | People | **Profile** (screen: **Contact info**) | In-chat header tap; Chats › Friends/People/Search › Profile | 2 | View the visible official profile without starting a DM; conversation-backed profiles also show available presence, groups in common and contact details. See [client usage](../apps/mobile/README.md#set-a-private-contact-name). **Asks** lists the Stories this person shared with the viewer (the Stories feed narrowed to one author; enhanced mode only), each with **Respond** opening the Story. A collapsed **Private to you** card holds the viewer's own notes, importance, catch-up cadence and links to people, companies, ideas and projects; only the viewer ever sees it. |
| `ContactProfile` private names | People | **Set private name** / **Edit private name** | Chats › Friends/People/Search › Profile; or person chat › named header | 2 | See [private contact name usage](../apps/mobile/README.md#set-a-private-contact-name) and the [API/privacy contract](private-contact-names.md). |
| `PrivateThing` | People | **Private notes** (item name) | Contact Info › Private to you › a linked company, idea, project or person | 3 | One of the viewer's own saved things with its private notes and links; each link opens the next person or thing. Reached only from a link, so it sits one tap past the two-tap rule by design. |
| `CatchUp` | People | **Catch up** | Chats › New message › "Catch up" | 2 | People whose private catch-up date has passed, soonest first, with a Caught up action. Cadence is set on each person's Private to you card. |
| `CardEntry` | People | **Add friend** / **Save contact** | Profile › Scan a code › card; shared `/c/:token` link | 2 | Shows the public card and no-login vCard download. Sends an explicit friend request; pending and accepted states are shown on revisit. Old clients retain card-to-DM. |
| `PersonEntry` | People | **Add friend** | Chats › Find people › "Add friend" beside a person; shared person link | 2 | Public person preview with an explicit request action; Message keeps its existing DM behavior. |
| `AgentOverlay` | OpenChat Agent | **OpenChat Agent** | 1. Profile › "OpenChat Agent" row<br>2. In-chat overflow menu › "OpenChat Agent"<br>3. Asks tab › "Tell OpenChat Agent"<br>4. Story viewer › "Ask OpenChat Agent"<br>5. Desktop sidebar footer robot button | 2 | Dedicated agent interface. Also reachable directly as a pinned chat row in Chats. |
| World Issue Tracker board creation (agent chat) | OpenChat Agent | **OpenChat Agent** | Chats › pinned OpenChat Agent chat | 1 | Ask to create a board; see [board creation usage](../README.md#create-a-world-issue-tracker-board). |
| Profile capture (`ContactProfile`, `PrivateThing`) | People | **Capture a private note**, **+ Add ask** | Chats › People › person / **Private profile** | 2 | Saves original privately before optional AI review; typed connections and standing asks retain source and recorder. Undo survives leaving/reloading the page. |
| Saved people (`Friends`) | People | **Saved people**, **+ Add person** | Chats › **People** | 1 | Save a private person by name without an account, invitation or publication; open **Private profile** for notes and asks. |
| Contextual agent | OpenChat Agent | **Ask agent** | Header **Ask agent**, conversation action, or profile capture | 1–2 | Visible page/person context; server resolves owner-readable records. Optional saved context is sent only to the private agent conversation and stays there. |
| `AsksList` | Asks | **Asks** | Bottom tab "Asks" (enhanced experience mode) | 1 | Peer coordination, asks, offers, and match opportunities. Gated on enhanced mode. See [grouped intention controls](context-intention-lifecycle.md#owner-controls). |
| `StoryComposer` | Asks | **Share a Story** | Asks screen › "Share a Story"; Stories rail "+" button | 2 | Publish 24h stories, requests, and agent-only quiet searches to network. |
| `StoryViewer` | Asks | **Story** (Header: Author name) | Stories rail avatar tap | 1 | View network story, reply directly, or ask OpenChat Agent about it. |
| `SocialReview` | Asks | **Review** | Asks screen › "Review" card; AgentOverlay Review card | 2 | Review and approve/decline quiet match opportunities. |
| `Thoughts` | Stream | **Stream** | Bottom tab "Stream" | 1 | Personal entries; see [search, creation and actions](../README.md#messages-and-stream). Internal route names stay compatible. |
| `ConversationThoughts` | Stream | **Chat Stream** | 1. In-chat header "Stream" button<br>2. In-chat overflow menu › "Stream for this chat" | 2 | Compatibility door into [conversation content](conversation-content.md). |
| `Settings` | Settings | **Settings** | 1. Profile › "Settings" row<br>2. Desktop: sidebar avatar › account menu › **Settings**<br>3. Desktop shortcut (⌘,) | 2 | Account (Edit profile, email, **Sign out** — top card, no scrolling), experience mode, agent keys, theme, notifications, and legal info. |
| *(action)* `Sign out` | Me / Account | **Sign out** | 1. Profile › Account › Sign out<br>2. Settings › Account › Sign out<br>3. Desktop: sidebar avatar › account menu › **Sign out** | 2 | Clears the stored token and user, disconnects the socket, and returns to `Login`. The same word in the same places on phone, tablet, and desktop web; desktop adds the avatar menu because its avatar has no visible label. |
| *(action)* `Switch account` | Me / Account | **Switch account** | 1. Profile › Account › Switch account<br>2. Desktop: sidebar avatar › account menu › **Switch account** | 2 | Web only, when Ideaflow ID is enabled. App-local OpenChat sign-out, then Ideaflow sign-in with the provider's account chooser (`prompt=select_account`). |
| `Search` | Search | **Search** | Chats header magnifying glass; desktop shortcut (⌘K) | 1 | Search conversations and messages. |
| `BlockedUsers` | Settings | **Blocked users** | Settings › Legal & Account › Blocked users | 3 | Manage blocked contacts. |
| `GroupSettings` | Chats | **Group Info** | In-chat header tap on a group conversation | 2 | Group member roster, rename, add/remove participants. |
| `OriginalMessage` | Stream | **Original message** | Chats › Stream › Original message; chat Stream entry | 2 | Exact accessible source and nearby messages; unavailable source gives no chat data. |
| `Compose` | Chats | **Message with OpenChat** | External Unlinked profile CTA or incoming compose link | 2 | See [compose usage](../README.md#message-with-openchat-from-unlinked) and [incoming-link contract](unlinked-compose-contract.md). |
| *(action)* `ContextWebhookSetup` | Agents | **External agent webhooks** | Chats › Agent drafts › Set up webhooks | 2 | See [owner consent and availability](context-webhooks.md). |
| `ContextReview` | Agents | **Agent drafts** | Chats list utility row (including collapsed desktop sidebar) | 1 | Owner-only hosted Context inbox, opt-in off by default. Anthropic processing disclosure, exact source/reply/destination/current audience review, separate explicit Publish to quiet Context. Edits create a new draft for review; current and future authorized conversation members can read published replies. |
| *(action)* `ConnectAgentLink` | Agents | **Connect an agent** | Chats list utility row; Profile; Settings | 1 | Opens the shared Ideaflow connection hub for OpenChat, Unlinked, and Notestream Vision. No connection status is inferred from API key existence. API keys and repeatable setup copy remain in Settings. |
| `ContextLane` | Context | **Context** | Chats › conversation › Context | 2 | See [conversation content](conversation-content.md) and [Ask/Offer tracking and lifecycle controls](context-intention-lifecycle.md). |

---

## Architectural Principles

1. **Doors hang from nouns, not feature builders.** Features are filed under user concepts (Me, People, Chats, Asks, Stream, Settings), not under whichever team or PR introduced them.
2. **Avatar is "Me".** The user's face in the chrome is the single entry point to everything about themselves (their card, their QR code, scanning others' codes, profile editing, agent, settings).
3. **OpenChat Agent is always an ordinary chat.** The assistant conversation is created server-side upon sign-in and pinned in Chats. The agent noun is never hidden behind `enhanced` mode; only the coordination layer (Asks, Stories, Review, quiet matching) is gated.
4. **Reciprocal actions live together.** "Show my QR code" and "Scan their code" belong on the same surface (`Profile`), with "Scan a code" directly beneath the user's code.

Unlinked profile → Message resolves the live profile owner and opens their normal Chat, reusing the existing direct conversation. Unclaimed profiles → Get an invite link → My card. This uses the existing OpenChat inbox and shared Ideaflow account; an embedded Unlinked web Messages surface reuses it.

| Messages in Unlinked web | Unlinked header → Messages; a member profile → Message | Canonical OpenChat inbox embedded with Unlinked presentation and the same conversation IDs/history/read state; `docs/unlinked-compose-contract.md` |

Unlinked profile and People search **Message** links carry the selected public profile through `/messages` into the normal embedded conversation. Compose is only a resolving/error/invite entry screen, with no separate message form. Generic compose links open New message. The verified recipient is selected automatically; Send remains explicit.

Web chat-stack secondary screens have a visible **Back** control, including Search, New message and the scanner. Back returns to the previous chat screen; without local stack history it opens Chats. Native navigation keeps its platform back/dismiss behavior.

### Agent setup (OpenChat-8apt)

Settings → Agent keys exposes the visible **New API key** action and the shared
**Agent setup · OpenChat + Unlinked** guide at `/agents`. The same guide is
readable at `/llms.txt` and `/AGENTS.md`; the existing `/about/connect-your-bot`
bookmark remains valid. Copy agent setup explains context and response shapes.

### Landing page session (OpenChat-en7a)

The public `/` page verifies the current browser's OpenChat session. Signed-in
visitors see **Signed in as [name]** and **Open OpenChat**; signed-out visitors
see **Sign in**. It refreshes on return and cross-tab sign-out. Agent setup links
to the shared `/agents` guide instead of maintaining separate MCP snippets.
