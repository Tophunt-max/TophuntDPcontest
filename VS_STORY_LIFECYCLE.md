# Contest VS Story lifecycle

**Migration:** `0055_vs_story_publication.sql` · **Code:** `apps/worker/src/lib/vsPublication.ts`, `vsComposite.ts`, `matchStories.ts`

## Root cause of the early single-photo Story

`startMatch` in `apps/worker/src/routes/api.ts` inserted a `stories` row of type
`contest_announcement` with the creator's raw `mediaUrl` right after it created the
match. At that point the match was still `waiting_for_opponent`. The Expo client never
called `createStory` from the contest flow, and nothing else did either: no cron,
effect or retry created stories. That Worker insert was the only path.

Two related defects turned up during the trace:

- `deleteStory` deleted the story's media with no check on story type, so deleting
  a contest story removed the user's battle entry photo.
- `setMatchVsImage` let either participant upload any image and have it shown on the
  other participant's story.

## Behaviour now

| Step | Result |
|---|---|
| A creates a battle | Entry saved on `contest_matches.user_a`. Status `waiting_for_opponent`. `vs_story_status` NULL. **No Story.** |
| B joins | One D1 transaction claims the slot, takes B's fee and sets `vs_story_status='pending'`. This is the only way a match becomes eligible. |
| Publication (`waitUntil` after the join, then cron every 10 min) | Builds one composite at `vs-cards/battles/<matchId>-v<N>.jpg`, then writes two `contest_vs` stories with ids `contest_vs_story_<matchId>_<uid>`. Both point at that composite. |
| Client | `getMatchStoryStatus` returns `waiting_for_opponent \| preparing \| live \| failed \| unavailable`. The congratulations screen shows only that server-confirmed state. |

Manual Stories (`createStory`), Highlights and the story feed work as before.

## State machine

The match `status` column (waiting → active → completed/ended/cancelled) controls
voting and settlement, so it is left alone. Publication is tracked as a separate
sub-state of an active match:

```
NULL ──join claim──▶ pending ──lease──▶ processing ──both rows confirmed──▶ published
                       ▲                    │
                       └── transient ◀──────┤──── permanent / retries exhausted ──▶ failed ──admin retry──▶ pending
any non-terminal state when the match is no longer `active` ──▶ skipped
```

Invariants are enforced in SQL, not in client input:

- The join UPDATE requires `user_b IS NULL`, a creator snapshot, and `creator ≠ joiner`. The joiner's media must differ from the creator's.
- Publication runs only while `status='active'`. It requires two distinct participants who are not deleted or banned and are not blocking each other.
- Entries must be owned media: R2 `contests/` or `contest-entries/` keys, or a ready Bunny video whose `owner_uid` is that participant.
- `POST /upload` now stores `uploader=<uid>` on every object. `startMatch` and `joinMatch` reject an entry uploaded by another account before any fee moves, and publication rejects it again.
- Both story inserts and the `published` flip sit in one batch. They are gated on the lease token and on `status='active'`. The flip also requires both rows to exist.

## Idempotency and recovery

| Failure | Recovery |
|---|---|
| Concurrent joins or kicks | One conditional claim UPDATE wins. Other callers get `busy` or `already_published`. |
| Composite uploaded, DB write lost | Next run HEADs the deterministic key. If customMetadata matches (match, both uids, version), it reuses the object. No second render, no orphan. |
| Only Story A exists | `INSERT OR IGNORE` with deterministic ids plus the unique index on `(match_id,user_id) WHERE type='contest_vs'`. B takes A's `created_at`/`expires_at`. |
| Worker crash | The lease expires after 2 min and the cron reclaims it. |
| Timeout, R2 or Images error | Back to `pending` with backoff (30s doubling, max 1h). After 8 attempts → `failed`. |
| Bad input (malformed, unsupported, tiny, untrusted, missing) | `failed` immediately, written to `error_logs`. The paid join still succeeds. |
| Repair | `POST /admin/matches/:id/vs-story/retry` (full admin, audited; button in admin Match Detail). Never runs on published or non-active matches. |

Entry fees, refunds and settlement are not touched by any of this. They keep their
own ledger idempotency.

## Composite rendering

- The Workers runtime has no canvas, no `sharp` and no filesystem. The free plan
  allows 10 ms of CPU, which rules out WASM decoding of two photos. Decode, crop,
  composite and encode therefore run on the **Cloudflare Images binding**
  (`[images] binding="IMAGES"`), off the Worker's CPU budget.
- Text is not drawn with `.text()`, which needs a font URL and has a known platform
  failure mode. Handles, title and the VS badge are rasterised in-Worker into small
  PNGs: a built-in 5×7 bitmap font plus a native `CompressionStream` deflate, well
  under 1 ms. User text is folded down to that glyph set, so nothing user-controlled
  reaches a renderer except as pixels.
- Layout: 1080×1920 JPEG (q85). The creator is always on the left and the joiner on
  the right, each in a 504×896 panel with `fit: cover` and `gravity: auto`
  (saliency) and a 6px border. Nothing is stretched. Transparency is flattened onto
  black. The VS orb is centred over the gutter.
- Inputs are capped at 15 MB per photo and 5 MB per poster, and must be 64–12000 px
  per side. Bytes are sniffed, then `IMAGES.info()` validates them. The render has a
  25 s bound.
- Video battles: the composite uses each video's Bunny poster, and only once both
  videos are `ready` and the posters are on our pull zone. Until then the state is
  transient (`video_not_ready`). Original videos are never altered. No thumbnail is
  ever faked.
- **Cost:** one composite per battle, billed as Images transformations (the free
  plan includes a monthly allowance). Re-runs reuse the stored object.
- **If the binding is missing:** the state stays `pending` with
  `renderer_unavailable`, the cron retries it, and it fails after 8 attempts. After
  enabling the binding, repair with the admin retry.

## Privacy and cleanup

- **Visibility:** `public`, or `followers` for a private account.
  `applyVsStoryPrivacy` enforces this for VS stories on the feed, profile ring and
  highlights: a followers-only story reaches only the owner and their followers,
  and anonymous viewers never see it. Manual stories keep their existing read
  behaviour, which does not filter on `visibility`.
- **Blocking:** a VS story also shows the opponent. `applyVsStoryPrivacy` runs on
  the feed, on profile rings and on highlights. For a viewer who has hidden the
  opponent, it swaps the composite for the owner's own entry
  (`type: contest_entry_solo`).
- **Ownership:** the composite belongs to the match.
  - `deleteStory`, the expired-story sweep and account deletion never delete
    contest-story media or any `vs-cards/` URL through a story.
  - `sweepVsComposites` deletes the composite only when no live story of that battle
    references it, or once the story window has passed after both owners deleted
    theirs early.
  - Match rows and both original entries are kept.
- **Account deletion** of a participant destroys their composites and every VS story
  showing them, including the opponent's.
- **Admin cancel and moderation "remove match"** both call `teardownVsStories`. It
  removes the VS stories and marks unfinished publications `skipped`.
- `vs-cards/` is now server-only, so clients can no longer upload there.
  `setMatchVsImage` is read-only. It returns the server card or refuses, and never
  deletes anything (deleting a caller-named URL would let anyone erase another
  battle's card).
- The lease is re-checked right before the R2 put. A worker that lost its claim
  mid-render writes nothing.

## Known limitations

- Photo entries uploaded **before** this release have no `uploader` metadata. They
  are accepted, both to keep in-flight battles working and because older uploads
  are indistinguishable. Ownership is enforced for every upload made from this
  release on.
- Video VS cards depend on Bunny posters. Legacy R2-hosted contest videos have no
  poster, so they end in `failed / video_poster_unavailable`. The battle itself is
  unaffected.
- The composite is cached `immutable` on a deterministic per-version URL. After the
  sweep deletes it, a copy someone saved may still be served from the edge cache.
  This is the pre-existing `vs-cards/` caching behaviour (see
  MEDIA_ARCHITECTURE.md).
- The opponent-hiding rule relies on `hiddenUidsFor`, which fails open if the block
  lookup errors (pre-existing helper behaviour).

## Deployment

1. Images binding: confirm Cloudflare Images is enabled on the account.
   `wrangler.toml` declares `IMAGES` for prod and staging.
2. Migration 0055 is additive. It adds columns and indexes, and collapses any
   duplicate `contest_vs` pairs (none are expected). The Worker applies it
   automatically, or run `npm run db:migrate:remote` after review. **Historical
   matches are not back-published**, because `vs_story_status` stays NULL. A
   reconciliation for old battles would need an explicit plan.
3. Rollout order: deploy the Worker, then ship the Expo build. Old clients keep
   working: their capture upload to `vs-cards` is refused and they fall back
   silently.

## Staging validation

1. `wrangler deploy --env staging` (fill in the staging D1/KV ids first). Confirm
   `env.IMAGES` appears in the bindings list.
2. User A creates a photo battle. Expect no story in `/read/stories/feed` and
   `vs_story_status` NULL.
3. User B joins with a different photo. Within seconds, A and B each have one
   `contest_vs` story with the same `vs-cards/battles/…-v1.jpg`. Open it and check
   left/right, handles and badge.
4. Polling `getMatchStoryStatus` as B goes `preparing → live`. The app screen goes
   "Preparing your VS Story…" → "Battle ready! Your VS Story is now live."
5. Failure drill: temporarily remove the binding, join a battle, and confirm it stays
   `pending/renderer_unavailable`. Restore the binding, then use **Retry VS Story**
   in the admin and confirm `published`.
6. Have A delete their story and confirm B's still renders. Expire both
   (`UPDATE stories SET expires_at=0`) and run the cron. The object is gone,
   `vs_image_url` is NULL and the match is intact.
7. Have C block B. In C's feed, A's VS story shows only A's entry.
