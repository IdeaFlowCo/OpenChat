# Beeper read activation (manual Mac foreground flow)

Source for review, not an activation claim. No service, launch agent, enrollment,
account login or actual message read runs during installation or import. Source,
independent security approval, compatible server/native delivery and actual owner
acceptance are separate gates. This flow is **read-only**. Replies remain a separate write capability. Optional iMessage read support uses
the same GET-only flow, with its own explicitly selected Mac-local account.

The paired native device must already hold a separately reviewed OpenChat machine
pair. This capability uses the existing machine/device keys, but a *separate*
`beeper.read` grant, local SQLite authority and independently approved destination.
A generic machine agent or its turn operation cannot authorize Beeper. Web can
browse saved imports, but cannot import/sign a native selected-chat grant.

After delivery and approval, Jacob runs the following himself in a local Mac
terminal using the reviewed checkout and Node 22. No agent may run activation on
his behalf. Beeper Desktop must be running with its local API enabled. The API
credential stays in a **specifically selected local Keychain item**; this entry
point never discovers credentials or creates an account/API grant. The adapter
makes GET requests only to `127.0.0.1:23373`, with redirects disabled. The credential
itself may have broader provider capabilities; the read adapter cannot send.

1. Create an hour-long catalogue offer. Replace the placeholders with the existing
   machine pair route, exact signed-in OpenChat user ID, locally selected Beeper
   WhatsApp account ID, and the existing designated Keychain service/account:

   ```sh
   node scripts/beeper-client/foreground.mjs setup \
     --pair-route PAIR_ROUTE --owner OPENCHAT_USER_ID --account LOCAL_ACCOUNT_ID \
     --keychain-service DESIGNATED_SERVICE --keychain-account DESIGNATED_ACCOUNT
   ```

   Review the local disclosure prompt. The offer printed afterward has public
   keys/verifiers only. Paste it into **Chats → Beeper chats → Set up Mac
   connection**, review it and approve it. It is bound to the locally chosen
   OpenChat owner, destination, device, Mac and account. Copying/editing an offer
   cannot redirect its importer token to a different recipient.

2. Publish one bounded catalogue page, after its own local confirmation:

   ```sh
   node scripts/beeper-client/foreground.mjs catalogue --connection CONNECTION_ID
   ```

   This shares the locally approved network's chat titles, types and activity times with the approved
   private OpenChat account. No source previews, raw chat/account IDs, participant
   roster, media URLs or message bodies go into this catalogue. Each run advances
   at most one bounded local page; it does not claim the full account is loaded.

3. Select the intended chat locally on the Mac and approve its messages:

   ```sh
   node scripts/beeper-client/foreground.mjs approve-chat \
     --connection CONNECTION_ID --chat LOCAL_CHAT_ID
   ```

   The metadata lookup is confirmed locally first, then a separate prompt names
   the chat, attribution disclosure, destination, exact device and expiry. Paste
   the printed **encrypted** selected-chat grant into the native app's setup
   section. The paired device decrypts and verifies its authenticated title before
   its own explicit approval. A cloud catalogue/job cannot change this selection.

4. Start the manual foreground worker, after its local disclosure prompt:

   ```sh
   node scripts/beeper-client/foreground.mjs run --connection CONNECTION_ID
   ```

   Select that chat in OpenChat, then press **Authorize selected chat read**. Each
   read has a short-lived encrypted native intent. The Mac independently checks
   keys, account, chat, audience, destination, expiry, sequence, request and
   revocation before the actual GET and before actual upload. The token lookup
   finishes before these final dispatch fences. Ctrl-C stops foreground work;
   neither installation nor opening the app starts it.

The default private state directory is `~/.config/openchat-beeper`; existing paired
identity defaults to `~/.paseo/openchat-machine`. Explicit `--directory` and
`--pairing-directory` select owner-private local directories. Local configs contain
only their *designated* importer credential and source identifier mapping; keep
these on the Mac. Do not copy them or the pairing database to the cloud. A process
lease prevents concurrent CLI workers. The durable authority spool holds at most
one source page for each admitted read; acknowledgments erase confirmed payloads.
A separate opaque job journal resumes the *same* job after a dropped response,
including a committed final ACK, without repeating the source GET. Unknown source
outcomes stop for local reconciliation. They never fail over to another Mac.

Revoke an individual selected grant or the whole connection locally with:

```sh
node scripts/beeper-client/foreground.mjs revoke --grant LOCAL_GRANT_OR_CONNECTION_ID
```

This fences later GETs and uploads, including while credential lookup is pending.
Revoking the parent machine pair also denies this read grant. Cloud connection
revocation rejects later imports; existing private saved copies remain until
explicitly deleted. A compromised destination server can access data deliberately
disclosed into that account: device encryption protects Mac authority in transit,
not plaintext already imported or a compromised trusted client/update.


## Optional iMessage read account

WhatsApp remains the default; setup never scans all networks or silently falls
back to Messages. On macOS only, the owner may explicitly choose an **existing**
iMessage account that Beeper Desktop already exposes through its local API:

```sh
node scripts/beeper-client/foreground.mjs setup --network imessage \
  --pair-route PAIR_ROUTE --owner OPENCHAT_USER_ID --account LOCAL_IMESSAGE_ACCOUNT_ID \
  --keychain-service DESIGNATED_SERVICE --keychain-account DESIGNATED_ACCOUNT
```

The separate local catalogue approval names iMessage. The catalogue excludes
other networks and merged chats; the selected account/chat, authenticated network
label and device/Mac scope remain fixed through reads and refreshes. Existing
catalogue rows migrate to WhatsApp without changing keys or retained spool state.
An iMessage grant cannot run on a non-macOS foreground worker. Native grant approval
and read intent sealing reject a relay label that differs from the Mac-approved
network. This does not enable iMessage sending or make claims about recipient
phone-number privacy or encryption.

Beeper's current documentation says iMessage is available on macOS. Actual local
Beeper version, an existing iMessage account, API readiness and source permissions
still need owner acceptance; GCP fixtures do not verify them. If Beeper requires
Accessibility, Contacts or Messages-data permission for its own iMessage setup,
the owner must approve that setup separately. This integration neither installs
Beeper nor grants those permissions and never reads Messages SQLite or invokes
AppleScript. No credentials or Mac databases are copied to GCP.

References: [Beeper Desktop API](https://developers.beeper.com/desktop-api/) and
[Beeper iMessage on macOS setup](https://help.beeper.com/en_US/chat-networks/new-imessage-on-macos-getting-started-guide).


### Network-specific identity and compatible app version

Optional iMessage uses a distinct `openchat.beeper.imessage.read.v1` encrypted
header, `beeper.imessage.read` audience and authenticated `network: imessage`
selection/intent. An older WhatsApp-only app cannot open the new grant or issue a
Mac-accepted read intent. Install the reviewed compatible app before approving
this source. Existing WhatsApp v1 grants, wire headers, HMAC identity tuples and
staged receipts remain unchanged; no automatic re-enrollment occurs.

The iMessage account, chat, participant and message HMAC identities use a separate
network domain even if provider IDs match WhatsApp. The public offer's verifier
binds iMessage and its protocol. Server connections and immutable read jobs retain
that network; catalogue updates and delivery cannot relabel it. Saved-copy joins
also match network. The Mac independently pins the selected local source, while
the native device verifies the authenticated network before sealing its intent.

Legacy catalogue schema inspection and the additive WhatsApp-default migration
share a SQLite write transaction with local revocation. New iMessage grants need
fresh explicit local approval; unreviewed prototype grants are not a compatibility
path. Empty/all-filtered catalogue pages publish an explicit bounded empty report,
so waiting for the first Mac report differs from no supported chats on that page.
Saved histories and account exports name their source network. These changes do
not assert source readiness or authorize any real message access.
