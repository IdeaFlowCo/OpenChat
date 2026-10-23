# Message translation

Open a chat and choose **Translate**. Choose **Auto-translate** and a target
language (English, Simplified or Traditional Chinese, Spanish, French, German,
Japanese, Korean, Hindi, Arabic, or Portuguese). Each reader chooses their own
language; the other participant still receives the original message.

The default is **Offer to translate**. A conservative, local script check offers
setup when recent incoming text appears in a different writing system. Chinese
and mixed Chinese/English text are covered. It does not guess between languages
sharing Latin script; **Translate** is always visible, and enabling automatic
translation handles those languages too through server-side language detection.
No text is sent for translation merely to show the offer.

For a single message, long-press or choose its visible **More** button, then
**Translate to …**. This also works when automatic translation is off. To reply
in Chinese, use the existing composer transform **Translate…**, choose either
Chinese variant, review the draft, then Send.

Translated bubbles show **Auto-translated** (or **Translated** for a manual
request), the source and target languages, and **Show original**. Copy, reply,
forward, export and storage continue to use the untouched original. Disabling
automatic translation restores originals; explicitly requested translations
remain available. Same-language messages receive no translation label.

Settings contains the global default. Chat settings override mode and/or target;
**Use global default** clears both overrides. Preferences are stored per account
on this device, not synchronized between devices. Originals and translated text
are not stored in the preference record. A failed preference save is visible.

Translation uses the existing Anthropic service and requires connectivity.
Text is sent only after a manual request or enabling auto-translation. Displayed
incoming messages are queued one at a time, at most 50 starts/minute, with a
200-entry memory cache per signed-in account keyed by exact original and target.
The server shares the existing 60 requests/minute/user AI limit. Edits/target
changes invalidate the display; navigation, disabling auto, and sign-out cancel
unneeded work. Failures keep the original and offer a deliberate retry.
Messages over 12,000 characters remain intact with an explicit size explanation;
provider-truncated or malformed output is never displayed as a finished result.

## Android availability checked 2026-10-23

The canonical responsive client is at https://chat.ideaflow.app/app/ and includes
an installable PWA manifest. Android Chrome is the web delivery path. The landing
page's historical Expo APK link returned `BUILD_NOT_FOUND` during this check.
Android build configuration alone is not evidence of a current Play Store release.
