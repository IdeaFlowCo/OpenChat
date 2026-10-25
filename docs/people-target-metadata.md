# Read-only people target metadata

`oc_suggest_people` (`openchat:read`) serves first-party people pickers through
the existing Ideaflow read bridge. The authenticated owner is server-derived.
It returns only app user ID, public display name, proven canonical issuer/subject
when linked, accepted OpenChat friendship, human-DM presence and last human-DM
time. It never returns message bodies, email, private aliases or group activity.

Empty queries return known people or accepted friends. Name and exact-email
queries retain existing contact discovery rules. Bounded candidate subjects use
POST only and cannot bypass discovery or mutual blocks. The handler requires read
scope for agent keys; the connector additionally requires openchat:read.

A chat requires a nondeleted human `text` message in a direct conversation.
Conversation creation/lastMessageAt, imports, system and automated assistant or
secretary messages are not evidence. Socket messages are keyed by conversationId;
IN_CONVERSATION is not required. The query reads no body content.

This is a read projection: no inbox, conversation, friendship, notification or
message is created. Unlinked connection membership is authoritative in Unlinked;
a historical acceptance receipt or its empty DM is not current connection proof.

Tests: peopleSuggestions.integration.test.ts uses disposable Neo4j (CI5.26),
and ideaflowConnector.test.ts covers scope, strict arguments and POST-only IDs.
