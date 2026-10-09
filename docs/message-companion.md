# Saved messages and the Mac companion

**Security-review hold for this task:** keep all real message data local and
run the companion archive-only. Do not sync or import real data into production,
enable uploads, or deploy until the security review is complete and release is
authorized. Code validation and PR preparation may continue with synthetic data.

OpenChat's **Streams** tab opens **Saved from messages** directly. **All saved**
combines private captures across source conversations and directly written notes.
Select a conversation to see its stream. Click the person byline to open their
**Contact details**; **Stream** and **Contact details** are visible peer views.
Search and **Add** remain available. Add in All saved writes to My notes; Add in
a person stream writes there; Add in Contact details creates a labeled field.
Existing personal Stream notes remain under **My notes**.

Pin is an owner-private placement choice, independent of a contact field. Saving
or pinning an external message never publishes it, sends a reply, joins anyone
to OpenChat, or grants another app/agent access. The **Connections and notes**
door uses the existing Noos people overlay, with a stable source identity ref;
it does not merge people by display name. Cross-channel identity merging is not
automatic. A group thread is not treated as a single person's contact details.

## Capture gestures

On a Mac signed into Messages, the companion observes authored messages:

* An inline `#tag` saves that message; a linked `#tag` reply saves the original
  target with the reply's tags. URL fragments do not count as hashtags.
* A linked `🔖` reply saves; `📌` saves and pins to the private stream's top.
* Observable custom emoji reactions use the same mapping. Sending reactions
  is a separate platform capability; the companion never assumes it can.
* `#address` / `#contact` route a captured fact to Contact details, and
  `#remember` identifies a person note. The original words are retained.
* Missing reply linkage never guesses the preceding message. Undecodable,
  oversized, and explicitly confidential/identifier-like content is left in a
  local review queue referencing the original Messages record.

The hashtag backfill is bounded by history available on the Mac, including its
synced iCloud history. Run it on another Mac with the **same account namespace**
to reconcile gaps. GUIDs deduplicate source messages; different source threads
remain distinct. Native Apple Shared with You pins are not imported yet.

## CLI

No new Python packages are needed. `chat.db` is always opened read-only.

```sh
python3 scripts/message-companion/companion.py archive --full
python3 scripts/message-companion/companion.py status
python3 scripts/message-companion/companion.py save --guid MESSAGE_GUID --tag longevity
python3 scripts/message-companion/companion.py sync
python3 scripts/message-companion/companion.py watch --archive-only
python3 scripts/message-companion/service.py install --state /private/path/companion.sqlite3 --archive-only
python3 scripts/message-companion/service.py status
python3 scripts/message-companion/service.py stop
```

Use `--state`, `--messages`, `--config`, and `--account` **before** the subcommand.
The same account namespace must mean the same Messages account on each Mac.
`service.py install --archive-only` installs a local capture-only watcher before
server pairing. After pairing and lifting the security-review hold, run `service.py install --upload-enabled` to enable
uploads, or `service.py install --archive-only` to disable them again. Reinstalling
without either flag preserves the installed mode and state path. The service
uses a private outbox, exclusive watcher lock, periodic full reconciliation,
launchd restart, and retry with checkpoints retained. Stop unloads the service;
install loads it again. It runs independently of the OpenChat window, so the
same GUI can be installed on both Macs without keeping a window open.

In **Streams → Mac companion**, create a credential for that Mac. Save the
displayed configuration as `~/.config/openchat/companion.json`, mode `0600`:

```json
{"url":"https://chat.ideaflow.app","token":"occ_EXAMPLE_REPLACE_LOCALLY"}
```

The credential is write-only for this owner's capture archive. Only its SHA-256
digest is stored on the server. It cannot enumerate saved messages, use general
agent tools, or send messages. Disconnect revokes it. Existing embedded sessions,
agent keys, delegated connectors and anonymous clients cannot read this archive.

Explicit CLI sending delegates to the already-installed `imsg`:
`companion.py send --to HANDLE --text TEXT`. Capture never invokes sending.
Advanced iMessage operations depend on the installed connector and OS; this
implementation does not disable SIP or promise unsupported operations.

## Contact details

For an unambiguous single-person thread, the companion reads ordinary structured
fields from Apple Contacts (name, phone, email, postal address, organization, job
title, birthday, website). It imports a dated snapshot attached to the source
thread. Source field labels are preserved and checked alongside values; confidential
fields are omitted before queueing and scrubbed from staged snapshots before
upload. Canonical Contacts records are unchanged. Apple notes are excluded. The UI labels the snapshot **From Apple
Contacts**. Current code is source reading plus explicit address append, not a
general bidirectional sync engine or a replacement for every Apple Contacts field.

`add-address.applescript CONTACT_NAME STREET` appends an explicitly supplied
street through Contacts.app, requires exactly one matching contact, retains
other addresses and labels it “shared in iMessage.” It is idempotent and verifies
the saved value. Contacts.app controls permission and account synchronization.
Never write Contacts SQLite directly. Do not infer a city, home label or country
from an incomplete source message. Adding a detail in OpenChat does not silently
write it to Apple Contacts. Full field editing/conflict review is a later adapter.

## Data and API contract

`OpenChatCapture`, `OpenChatCaptureThread`, and `OpenChatCaptureDevice` are private
owner-scoped records in the existing application graph. They are deliberately
separate from shared `Message` and legacy hashtag-fanout `Thought` labels.
`/api/captures` provides paginated owner reads, direct Add, pin/tag editing and
Forget. `/threads` lists sources; `/threads/:id/person` connects an individual
source identity to the existing private relationship graph. `/devices` issues
and revokes source credentials; `/ingest` accepts only those dedicated credentials.

One source message has one capture per owner/source thread; new trigger events
union tags. Replays never re-pin an item the owner unpinned. Forget removes
payload and leaves a tombstone preventing reimport. The Mac's historical outbox
is a separate local archive; Forget in OpenChat does not erase Messages or that
local archive. Account export includes live saved messages; deletion removes
all captures, threads and devices for the owner. HTTP responses are no-store.

## Design continuation

The standalone mockups, OpenChat, and future Vision experience are different
views of the same intended records. The current shipping implementation lives
in OpenChat; there is no second app or Vision dual-write. WhatsApp is represented
in mockups but is not an enabled ingest channel yet. Future work includes an
explicit person identity join across channels, provider-native pin inspection,
source edit/retraction reconciliation, field sync conflict review, and Add related note
to an idea/project with linked source evidence. Private relationships already
use the shared people overlay; do not create a second knowledge graph.

Tests cover authored-only capture, exact reply resolution, URL fragments,
Unicode text, pins, idempotency, source privacy, direct entry, contact details,
cursor scopes, device revocation, forgetting and account lifecycle. Real Neo4j
integration runs in the existing CI database service.

Confidential identifiers and explicitly confidential labels/tags stay unsent.
Direct Add leaves the draft open and asks you to store it locally in an
appropriate secure app; it does not provide a durable local vault.

Service install resolves Python to its executable path and sets a working
directory. Reinstall preserves the installed state path and archive-only mode
unless explicitly overridden. Install/start success requires an observed running
state; status includes the last launchd exit code. A loaded job alone does not
prove the companion is running. For startup failures, inspect `launchctl print gui/$(id -u)/com.openchat.message-companion` and the log paths in the installed
plist locally; do not share private log contents.

Run the installer with the interpreter already authorized to read Messages,
Contacts, and the external archive. The installed job uses that interpreter's
resolved executable; permission for another Python or terminal is insufficient.
On this M4, the Command Line Tools Python lacked Full Disk Access. The existing
authorized interpreter can be used explicitly (no TCC changes are made):

```sh
/opt/homebrew/Cellar/python@3.12/3.12.13_4/Frameworks/Python.framework/Versions/3.12/bin/python3.12 scripts/message-companion/service.py install --archive-only --log-dir "$HOME/Library/Logs/OpenChatCompanion"
```

Omit the mode flag to preserve the installed mode, or use `--archive-only` for
local capture. The interpreter path is machine-specific; use an authorized
installed interpreter on other Macs. Pipeline review does not manage the live
service.

New installs put small stdout/stderr logs in `~/Library/Logs/OpenChatCompanion`,
independently of the archive's `--state` path. Use `install --log-dir PATH` to
choose log storage; reinstall without that option preserves existing log paths.
To migrate an older installation whose logs are beside the external archive,
explicitly pass `--log-dir "$HOME/Library/Logs/OpenChatCompanion"`. The archive
stays external, and the state path and upload mode are preserved unless overridden.

On this M4, launchd could not open log files on the protected external volume
before starting Python. The interpreter's Full Disk Access does not grant that
pre-launch operation to launchd. Local logs plus the already-authorized Homebrew
Python realpath have been proven to run archive-only. This is separate from
Python needing permission to read Messages and the external archive; no TCC
changes or live-service actions belong to pipeline review.

Explicit confidentiality labels use the shared `scripts/message-companion/capture-privacy.json`
policy in mobile drafts, companion message/trigger screening, and contact fields.
Matching normalizes a temporary copy (NFKC, lowercase, label separators); source
text remains exact. Broad matches such as account, routing, IBAN, social security,
tax ID, passport, driver license, and card number stay local even when no numeric
pattern matches. These are conservative heuristics, not detection of every kind
of sensitive information. The installer copies the policy with the companion.
