# Chat, realtime, notifications and the social graph

How these behave after Phase F, and the rules a change must keep. Code paths are
under `apps/worker/src` (Worker) and `apps/expo` (app).

## Chat

**Storage.** Message bodies live in one `ChatArchive` Durable Object per chat
(`chatArchive.ts`). D1 keeps the inbox row (`chats`) and membership
(`chat_members`: unread counter, `cleared_at`).

**History** (`GET /read/chats/:id/messages`):
- No parameters: the newest 50 messages, oldest-first. `X-Next-Cursor`
  (`<createdAt>_<id>`) names the next older page; pass it as `?before=`.
- `?since=<ms>`: messages after that time, up to 200 (the old contract, kept for
  installed apps).
- Both start after the viewer's `cleared_at`. The response is `private, no-store`.

Before this, opening a thread returned the oldest 200 messages, so a conversation
past 200 messages never showed a new one.

**Sending** (`sendMessage`):
- The app sends a `clientId` (8-64 of `[A-Za-z0-9_-]`, one per message, reused by
  Retry). The message id is `<senderUid>_<clientId>`, so a retry after a lost
  response returns the stored message (`duplicate: true`) instead of creating a
  second one.
- The unread counter is bumped only for a new message. The inbox preview and the
  realtime events are re-applied on a retry; clients key messages by id.
- The response includes the stored `message`, which replaces the optimistic
  bubble (it already has the same id).
- Without `clientId` (old apps), every send is a new message.
- A message is "sent" in the app only after the server answers. There is no
  offline queue for messages: a failed send is removed and offered for Retry.
- The DO append and the D1 updates are separate writes. If the D1 part fails, the
  message is stored; Retry repairs the preview without double-counting.

**Read state.** `markChatRead` clears the member's counter, then the DO read flags.
That order can overcount by one message that lands in between, never undercount.
The app marks read on open and whenever a new incoming message arrives while the
chat is open. Per-message read receipts are not exposed to clients.

**Delete chat** is delete-for-me (migration 0066). The caller's `cleared_at` is set:
the chat leaves their inbox until a newer message and their history restarts. The
chat and its messages are purged only when every member has cleared past the last
message. It used to purge for both members.

**Blocks.** Sending and typing are refused in both directions. The inbox hides the
chat. History stays readable by id. Presence is not sent to a blocked chat
partner.

**App thread state** (`src/lib/chatThread.ts`): refreshes merge by id, keeping
older pages and in-flight bubbles. "Load earlier messages" pages back.

## Realtime (`/ws`, `RealtimeHub`)

| Channel | Who may subscribe |
|---|---|
| `user:<uid>` | That user |
| `chat:<id>` | A chat member |
| `match:<id>` (signed in) | Anyone for a public battle (any status); invite-only needs a participant or the invited player |
| `match:<id>` (guest) | Live, public battles only |
| `app:cfg<N>` | Anyone (no token) |

- The token and session are checked at the upgrade only. An admin block or a
  session revocation closes open sockets (`closeRealtimeSessions`, best-effort).
- Upgrade answers: 401 rejected token or session, 403 not allowed, 503 when the
  check itself failed (D1, Google keys). A key-fetch failure used to be 401.
- **App:** a socket that never opens three times in a row triggers one
  authenticated HTTP probe; only a real 401 there signs the user out. Before, the
  refusals alone signed out, and a 403 on a deleted chat or an outage looked the
  same.
- **Missed events:** the hub does not replay. On every REconnect each listener
  gets `{ type: 'resync' }`, and `live()` refetches on it whatever its filter, and
  when the app returns to the foreground. The safety poll (60 s, 180 s for
  notifications) remains.

## Notifications

- **Collapse:** like/comment/follow-type rows collapse per (recipient, type,
  target) for 7 days; the same actor within 60 s is absorbed.
- **Badge:** unseen rows (`seen = 0`) without blocked or muted actors. Used by
  the bell, `/read/notifications/unread-count` and the push badge
  (`unseenNotificationCount`). The push badge used to count never-tapped rows.
- **Paging:** `(created_at, id)` keyset; `X-Next-Cursor` is `<createdAt>_<id>`.
  A bare time is still accepted. The app pages with the server's cursor.
- **Push tokens:** at most 10 per account (newest kept); a token is detached from
  other accounts on registration and removed on sign-out. FCM `UNREGISTERED`,
  `SENDER_ID_MISMATCH`, or `INVALID_ARGUMENT` naming the token removes that token,
  in SQL against the current row. A payload error no longer deletes tokens.
- **Sign-out (deliberate or forced):** local account data, the local push token,
  the app-icon badge and delivered alerts are cleared. A forced sign-out cannot
  call the server; revocation already cleared the server tokens. A plain token
  expiry leaves the server token until the next login on that device detaches it.
- **Taps:** routed through `getNotificationDestination` (internal paths only). A
  tap that launched the app from killed is routed once.

## Social graph and comments

- Follow and unfollow counters move only when the edge changed (gated in the same
  batch). Block deletes follows, requests and request notifications both ways.
- Follower/following lists page on `(created_at, uid)`.
- Comments: the battle or post must exist. A private account's post thread is for
  followers (read and write). A `clientId` makes a post idempotent, including two
  requests in flight at once. Delete decrements once and publishes the count.
  Comment likes take an explicit `liked` state; counters move only when the like
  row changed.
- Replies are flat (`@username` prefix); `parent_id` is unused.

## Known gaps

- The Durable Objects' own SQL is not run in tests; the harness fake mirrors it.
- No offline outgoing-message queue, no read receipts, no reply threads.
- Signed-in sockets have no per-user cap. Token expiry is not re-checked on an
  open socket.
- A notification tap is not checked against the signed-in account.
- `follow` notifications collapse per follower, so "A and 3 others followed you"
  never appears (product decision).
- Going public refreshes caches for at most 50 approved requesters.
- The app's followers/following screens load the first page only.
