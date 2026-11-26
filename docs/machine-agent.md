# Pair a device to a machine agent

In the installed OpenChat app, open **Chats › Machine agent**. Give the public device key to the operator of your computer over a channel you already trust. The operator compares the whole key, chooses one dedicated existing Paseo agent and workspace, and returns a private offer. Paste it into **Private machine offer** and select **Pair device**. Keep the offer out of chat messages, logs, URLs and screen recordings.

**Send to machine** opens a private request. The operator sees the exact text and approves it in the machine terminal. **Check last turn** retrieves the encrypted receipt after a disconnect. When delivery is uncertain, inspect the dedicated Paseo agent before repeating a request. **Forget device key** removes the key from this app account. The machine operator can revoke the grant independently.

## Machine operator

Use the reviewed checkout, its pinned npm dependencies, Node 22.13 or later and your installed Paseo fork. Set `OPENCHAT_PASEO_SDK` to the absolute path of that installation's `packages/client/dist/index.js` and `OPENCHAT_PASEO_PORT` to its local TCP listening port. The bridge connects to IPv4 loopback. A daemon that requires a password uses the operator's established local `PASEO_PASSWORD` mechanism. Use a dedicated agent that nobody else messages and a workspace suitable for the approved consumer. The adapter checks its exact UUID, canonical working directory, idle state, provider and pinned mode before every send. Supported Codex modes are `auto` and `read-only` where the installed daemon offers it. The operator sees the selected mode when granting access.

Run these commands from the OpenChat repository. Run `offer` and `serve` in an interactive terminal. The arguments below contain only the public device key, route and local scope.

```sh
node scripts/machine-agent/host.mjs offer DEVICE_PUBLIC_KEY AGENT_UUID /absolute/workspace
node scripts/machine-agent/host.mjs serve ROUTE
node scripts/machine-agent/host.mjs list
node scripts/machine-agent/host.mjs revoke ROUTE
```

The offer command asks for local approval and saves the private offer in a mode-0600 file under the owner's mode-0700 state directory (`~/.openchat-machine` by default). It prints the path. Deliver the contents privately. The offer expires after 10 minutes. A grant lasts 24 hours. The foreground listener deletes consumed or expired offer files. A copied file becomes unusable after activation or expiry. To replace an expired grant, revoke its route first. Each grant has an exclusive agent. Version 1 pairs one machine per native app account on a device.

The operator confirms each prompt separately. The existing provider may use tools allowed by its local configuration and show its normal approval prompts. A working directory selects the agent's workspace. OS accounts, filesystem permissions, provider sandbox settings, configured connectors and secrets determine the actual filesystem and network boundary. An operator who needs strict filesystem isolation should give that agent a suitably isolated account or container. The machine bridge has no authority to approve provider prompts.

If the bridge stops during a request, the durable reservation prevents automatic resubmission. Inspect the agent locally and revoke/re-pair if the reservation is uncertain. Revocation discards the ciphertext receipt and blocks further work immediately. For a dispatched request, revoke also asks the local daemon to interrupt the dedicated agent. Check the local agent if interruption fails. An action already performed by a provider cannot be undone by revoking a grant.

## Protocol and threat model

The mobile device creates a Curve25519 keypair with Expo Crypto's native CSPRNG. SecureStore holds the secret key, pending offer and request counter under the local account. On iOS the keychain item uses `WHEN_UNLOCKED_THIS_DEVICE_ONLY`. Secure storage failure stops pairing. The machine keeps its identity, individual grant pins, offer hash and durable request record in an owner-private SQLite database. A machine persists one identity across devices. Identical account credentials on another handset do not reproduce the device key.

The bridge uses TweetNaCl's Curve25519/XSalsa20-Poly1305 box with independent random 192-bit nonces and rejects all-zero Diffie–Hellman results. The authenticated plaintext contains the versioned protocol label, grant/session routing ID, both public keys, direction and request contents. Replies bind both a counter and a random request ID. A status check uses a fresh challenge and names the original request inside the ciphertext. Device keys and the machine public key are exchanged out of band. Relay messages cannot replace either pin. Activation also requires the local one-use secret and proof of the pinned device key.

The mobile app advances its sequence before sending. On the machine a SQLite transaction reserves the new sequence, authenticated contents hash and request ID before terminal review. High-water marks reject older sequences. Repeated delivery of the current message retrieves its existing receipt. A higher sequence can skip a lost request. A higher sequence cannot displace a request under review or in flight. Only the most recent receipt is retained. An interrupted dispatch has an explicit uncertain outcome. Retry never causes a second provider dispatch of that request. A machine backup restored to an earlier point must use a new identity and new grants before reconnecting.

The OpenChat Socket.IO namespace requires a direct OpenChat login for devices. This controls use of the relay. The machine independently authenticates the device and every command. The relay sees addresses, route, device login, sizes and timing. It can drop, delay, duplicate, reorder or withhold traffic. It keeps no plaintext or durable message history. A group, mention, forwarding operation, webhook, auto-response or server agent has no route into machine dispatch. There are no plaintext, shell, session-creation, provider-selection, or grant-management commands on the channel.

Keep the client and machine independently trusted. Web users see native pairing instructions. A compromised web origin could use even a non-extractable browser key while its page was open. Native OS signatures authenticate the installed app. EAS project access, OTA delivery and the contents of a native update remain trusted unless an independent publisher certificate is embedded and checked by the binary. The 1.0.20 app config has no Expo Update code-signing certificate. Per-message terminal consent is therefore mandatory. A malicious client update could steal app-readable device keys or capture plaintext; the terminal's independent review remains essential. Full compromise of the target GCP host, user account or local daemon can change policy or read keys and ends the protection. Static device keys do not provide forward secrecy. The selected provider receives the approved plaintext and Paseo can retain local history.

## Design sources

Paseo's relay uses TweetNaCl box, checks for low-order keys, and pins the machine key in its connection offer. Its paired transport exposes a daemon API broader than OpenChat needs. This bridge exposes one bounded agent message and a receipt. [Paseo relay source](https://github.com/tmad4000/paseo/blob/135a3b4c9e49a28b9d16ced8fc0e45b4da9fc502/packages/relay/src/crypto.ts)

The private Chat Coach host binds a browser key with a short-lived machine-generated secret and protects traffic with directional replay checks. Its host security notes also document hosted-page trust and copying results into server history. OpenChat keeps results in its machine view. Buzz uses a session-bound pairing transcript and an out-of-band comparison. OpenChat's operator compares the full device public key and passes the machine offer out of band. [Buzz pairing transcript](https://github.com/tmad4000/buzz/blob/e5a3168aa64057a277c39406fe6f1957b2581534/crates/buzz-core/src/pairing/crypto.rs) · [Chat Coach host security at the reviewed revision](https://github.com/IdeaFlowCo/chat-coach/blob/646ccecb5454af38547566aa650f25f72c4fc38b/docs/host-security.md)

The native cryptography requirement is secure random bytes. The box implementation is JavaScript and the existing Expo modules provide random bytes and secure storage. A Linux Expo export produces distributable JS and Hermes assets. Installed-client execution and update acceptance require a device receipt. Adding an independent Expo Update signing certificate requires a new native build and runtime. [Expo SDK 54 Crypto](https://github.com/expo/expo/tree/sdk-54/packages/expo-crypto) · [Expo Update code signing](https://docs.expo.dev/eas-update/code-signing/)

## Verification

CI exercises device and scope substitution, wrong tokens, expiry, duplicate activation, interrupted requests, reordered and replayed ciphertext, revocation, private result extraction, direct-session relay authentication and the actual mobile service through a local socket relay. The native-service test substitutes secure storage and randomness at the platform boundary.

For a local Paseo integration run, set `PASEO_TEST_INSTALL` to the installed fork distribution at revision `2273c4d67674d05ba4915dccfc6ba6eed1ed75a6` and `PASEO_TEST_SOURCE` to the source repository containing that revision. Run `node --import tsx scripts/machine-agent/paseo.e2e.mjs`. It creates a separate daemon and relay, a temporary workspace and a deterministic test provider from that exact Paseo revision. It pairs synthetic keys, sends a message, and verifies a single provider invocation and an encrypted answer. The operator confirmation in this fixture is synthetic. The product CLI requires a terminal.
