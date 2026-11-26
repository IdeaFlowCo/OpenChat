# OpenChat communities

From **Chats → Communities**, create a private community or join one with a code
given to you by its admin. A community is a directory of related OpenChat group
chats, with its own Announcements chat. It uses the existing chat/history store.

Joining a community explicitly joins Announcements. It does **not** join any
subgroup. Each listed group has a separate **Join** action: joining grants the
same history access as ordinary OpenChat group membership. Community members
see group names in the directory, not previews, messages or subgroup rosters.

An admin can create a subgroup. Linking an existing group also requires being
that group's owner and confirming that community members may see its name and
choose to join its history. Linking never enrolls existing group participants
in the community. Direct chats, announcement chats, Unlinked-managed groups,
and already linked groups cannot be linked. Unlinked roster/invite controls
remain authoritative for those managed groups.

## Roles and membership

- Members read Announcements, react, browse groups and explicitly join them.
- Admins also post announcements, edit the community, manage its directory,
  create/revoke invite codes, and remove ordinary members.
- The owner also appoints/demotes admins, removes admins and transfers ownership
  to an existing member. Transfer keeps the previous owner as an admin.
- An owner must transfer ownership before leaving. Leaving/removal revokes
  Announcements access, while independently joined subgroup memberships stay in
  place. Leave those chats separately through their normal group controls.
- Removing another member revokes outstanding community codes to prevent reuse.

Announcement messages and shared Context contributions are admin-only in this
first slice. Member replies are deferred; existing reactions remain available.
Private Stream captures remain private. This feature does not claim WhatsApp's
phone-number privacy rules, end-to-end encryption, quotas, or contact import.

## API and graph contract

`/api/communities` requires a direct signed-in OpenChat person. Embedded sessions,
agent keys and delegated connectors receive no new community-management powers.
There is no public community directory or unauthenticated invite preview.

| Route | Action |
| --- | --- |
| GET /api/communities | Your communities |
| POST /api/communities | Create with `name`, optional `description` |
| POST /api/communities/join | Join with a private `token` |
| GET /api/communities/:id | Member-only directory and community roster |
| PATCH /api/communities/:id | Admin edits `name` and `description` |
| POST /api/communities/:id/groups | Admin creates a group with `title` |
| POST /api/communities/:id/groups/link | Admin/group-owner links `conversationId` with explicit `allowCommunityJoin:true` |
| DELETE /api/communities/:id/groups/:conversationId | Admin unlinks; memberships/history stay intact |
| POST /api/communities/:id/groups/:conversationId/join | Member explicitly joins a subgroup |
| PATCH /api/communities/:id/members/:userId | Owner assigns `role`: member, admin, or owner |
| DELETE /api/communities/:id/members/:userId | Self-leave or authorized removal |
| POST /api/communities/:id/invites | Admin generates a replacement code |
| DELETE /api/communities/:id/invites | Admin revokes outstanding codes |

Codes contain 256 random bits; only SHA-256 hashes are stored. A replacement
invalidates the previous code. Codes expire after seven days and are rechecked
inside the membership transaction, along with blocks. Copying a code does not
send invitations. Technical bounds are 100 communities per person, 100 groups
per community and 500 community members; no new dependencies are needed.

Graph additions are `OpenChatCommunity`, `OpenChatCommunityInvite`, and
`IN_OPENCHAT_COMMUNITY` / `HAS_OPENCHAT_GROUP` / `HAS_OPENCHAT_INVITE`
relationships. Announcement chats remain `Conversation` nodes with
`communityKind:'announcements'` and ordinary `PARTICIPATES_IN` relationships.
The two new uniqueness constraints are additive and namespaced to OpenChat.
Existing chat messages, Unlinked groups, grants and other shared graph labels
are not migrated or copied.

Community transactions lock the community, its announcement conversation and
then any child conversation they change. Posting and shared Context writes lock
the conversation and recheck current authority; leave/demotion locks that same
announcement conversation. HTTP, socket, forwarding and internal agent message
writers enforce the posting rule. Notifications contain only an opaque community
ID and are emitted after commit, including after a retried transaction. Message
fanout independently selects current participants under the existing ACL lock.

## Release and rollback boundary

Source merge does not establish production deployment or native Apple behavior.
The shared-host operator must bind a release to the actual current server and
web artifacts, preserve newer G2 behavior, obtain the coordinated window, and
record installed hashes/manifests and rollback acceptance. Never replace live
G2 wholesale with an older main image.

Rollback to server code without community guards requires pausing announcement
membership first, while writes are fenced. Save each announcement
`PARTICIPATES_IN` relationship's properties in an OpenChat-only rollback receipt
or paused relationship, then remove its active membership. Otherwise old code
could treat Announcements as an ordinary writable group. Keep community nodes,
child memberships and history intact. Restoring a community-aware server can
restore only the saved announcement memberships whose community membership is
still valid. The exact pause/restore transaction and fresh baseline must be
reviewed and rehearsed in the release packet; this document alone is not an
operator authorization or an executed migration.
