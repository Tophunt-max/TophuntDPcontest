# Media architecture — images on R2, video encoded by Qencode into R2

Companion to MEDIA_MIGRATION_PLAN.md, which is the historical plan (written for
Bunny Stream, since replaced by Qencode). This is the current design: what lives
where, what the bucket looks like, and how to complete or reverse the video
cutover.

## The split

| Media | Store | Delivery |
|---|---|---|
| Images | Cloudflare R2 (`tophunt-media`) | `media.tophunt.in`, resized by Cloudflare Transformations |
| Video | Qencode encodes; output stored in R2 (`videos/<id>/`) | `media.tophunt.in` — HLS natively on iOS/Android, hls.js on web |

### The video pipeline

1. The app calls `createVideoUpload` (with `upload: "worker"`). The Worker creates
   a `videos` row (`uploading`) with a new uuid.
2. The app POSTs the file to `/upload/video?videoId=<id>`. The Worker checks the
   magic bytes, stores it at `video-src/<random uuid>.<ext>` (deliberately not
   the video id, which is public once the playlist URL is on a story), and starts
   a Qencode job:
   source = a presigned R2 GET, output = `s3://<account>.r2.cloudflarestorage.com/<bucket>/videos/<id>/`.
   The row becomes `processing`.
3. Qencode writes `videos/<id>/playlist.m3u8` (HLS 360p/480p/720p) and
   `videos/<id>/thumbnail.jpg`, then calls `/webhook/qencode?v=<id>&sig=<hmac>`.
4. `applyEncodeResult` (lib/videoReconcile.ts) re-reads the job from Qencode
   `/v1/status`, checks the playlist exists in R2, marks the row `ready`, and
   deletes the raw source. The same function runs from the 10-minute cron and
   from the app's `videoStatus` poll, so a lost callback costs latency, not
   correctness.

The app never talks to Qencode. Qencode's tus upload credential (the task token)
can also start jobs with any settings, so handing it to the app would let any
account run encodes billed to us. Uploading through the Worker also means the
bytes are verified before we pay to encode them. The trade is resumability: an
upload that drops restarts from zero (with retries), instead of resuming.

Audio is in **neither**: story music previews are `musicTracks.previewUrl`, which
points at the externally hosted catalogue. There is no audio in the bucket and no
category for it — if that ever changes it needs a registry entry, or it will have
no cache policy and no lifecycle rule, which is the exact failure the registry
exists to prevent.

One module decides this and nothing else is allowed to:
**`apps/worker/src/lib/mediaRouting.ts`**. Its client mirror is
`apps/expo/src/services/media/uploadVideo.ts`. The Qencode integration itself is
**`apps/worker/src/lib/qencode.ts`**.

### It is a switch, not a deletion

Qencode is not provisioned in this deployment yet, so removing the legacy R2
video path outright would leave no video path at all. Instead the split is
enforced by `integrations.video.provider`:

| `provider` | Qencode config | Video goes to | `POST /upload` accepts raw video? | `media_routing` health |
|---|---|---|---|---|
| `qencode` | complete | **Qencode → R2 `videos/`** (current builds) | Yes, for pre-Qencode builds only | ok |
| `r2` | any | R2 (legacy raw MP4) | Yes | ok, reported as legacy |
| `qencode` | incomplete | R2 (silent fallback) | Yes | **fails** |

"Complete" means `QENCODE_API_KEY` **and** the R2 S3 credentials
(`R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`), since
Qencode reads the source and writes the output with them.

The third row is the case worth naming: someone selected Qencode and did not
finish wiring it. Behaviour is identical to a deliberate legacy setup, so without
a distinct health signal a half-finished cutover looks like a working deployment.

A stored provider value of `bunny` (from before Bunny was removed) is read as
`r2`. Bunny was never provisioned, so that is what it meant.

Both directions are an admin-panel setting — no deploy, no client release.
Rollback from a broken encoder setup has to be faster than a deploy.

## R2 folder structure

Declared once in **`apps/worker/src/lib/mediaCategories.ts`**. That file is the
bucket's table of contents; this table is generated from it by hand, so if the two
disagree the code wins.

| Prefix | Writer | Cache | Retention | Notes |
|---|---|---|---|---|
| `avatars/` | user | immutable | — | Image-only is what stops an 80 MB "profile picture" |
| `profile/` | user | immutable | — | Covers and other profile imagery |
| `posts/` | user | immutable | — | Feed images |
| `stories/` | user | immutable | 30 d | Expire in 24 h; media swept by the story cron |
| `chat/` | user | immutable | — | DM images |
| `contests/` | user | immutable | — | Contest entries. What the current client sends |
| `contest-entries/` | user | immutable | — | Legacy alias for builds still in the wild |
| `vs-cards/` | server | immutable | 7 d | Server-rendered battle cards (`vs-cards/battles/<matchId>-v<N>.jpg`, see `VS_STORY_LIFECYCLE.md`); deleted once no live story references them |
| `deposits/` | user | immutable | — | UPI screenshots. See the retention note below |
| `reports/` | user | immutable | — | Abuse-report evidence |
| `misc/` | user | immutable | — | Unclassified fallback |
| `contest-banners/` | **admin** | **no-store** | — | Has a real deletion lifecycle |
| `payment-qr/` | **admin** | immutable | — | Shown on the deposit screen |
| `blog/imported/` | **server** | immutable | — | Importer only; keyed by content hash |
| `videos/` | **server** | immutable | — | Qencode output: `videos/<uuid>/playlist.m3u8`, renditions, `thumbnail.jpg` |
| `video-src/` | **server** | no-store | 2 d | Raw uploads Qencode encodes from; deleted when the encode finishes |

`writer` is enforced: `POST /upload` derives its allow-list from
`writer === "user"`, so an admin- or server-owned prefix cannot be opened to
clients by omission. A user who could write `contest-banners/` could plant or
clobber a banner shown to everyone.

### Key layout

```
{prefix}/{YYYY}/{MM}/{uuid}{ext}      new uploads
blog/imported/{sha256}{ext}           content-hash keyed, deliberately NOT sharded
videos/{uuid}/…                       one folder per encoded video, NOT sharded
video-src/{random-uuid}{ext}          temporary raw upload, NOT sharded; key on videos.source_key
{prefix}/images/{uuid}{ext}           legacy, still served and still deletable
```

The month shard exists because R2 lifecycle rules, Cloudflare cache rules and
`wrangler r2 object list` are all prefix-based. A flat prefix holding every avatar
ever uploaded is one you cannot expire, cache-rule, or enumerate selectively.

`blog/imported/` is excluded: the hash *is* the key, and a date in front of it
would give identical bytes a different key each month, turning deduplication into
a slow way of storing duplicates.

**Nothing was migrated.** Old keys keep working because everything that maps a URL
back to a key matches on the *category prefix*, not the full old string. The two
layouts coexist indefinitely; there is no backfill to run and no D1 rewrite.

> The subtle part, recorded because it nearly shipped broken: the URL→key mapper
> used to require a **single path segment** after a trusted prefix. That is
> equivalent for flat keys and rejects every sharded one — and it fails *silently*.
> `contestBannerKeyFromPublicUrl` returns null, the delete hits nothing and reports
> success, and every new banner and battle card leaks while deleted banners stay
> readable behind a live URL. It is now `isSafeRelativeKey`: bounded depth, no
> empty segments, no `.`/`..`, and a charset excluding `/`, `%` and `\` so neither
> raw nor percent-encoded traversal survives.

### Cache policy

`immutable` because the key contains a UUID or a content hash, so the bytes behind
a URL never change. `contest-banners/` is the exception — it has a deletion
lifecycle, and a removed banner that stayed cached would remain public in another
colo for up to a year.

`contest-banners/` and `vs-cards/` are also **proxy-only**: they keep being served
through the Worker's `/media/*` route at their stored URL, never canonicalised onto
the CDN base and never transformed. Cache *identity* is the reason — the `no-store`
policy and the colo purge in `deleteContestBannerByPublicUrl` are both keyed to
one exact URL, and a canonicalised URL is a different cache entry that no delete
path purges. Worth a Worker invocation only on the two smallest, coldest prefixes;
`stories` are also cron-deleted but hot and numerous, so they take the CDN path.

## R2 lifecycle rules to apply

Not applied by code. Configure in **R2 → `tophunt-media` → Settings → Object
lifecycle rules**:

| Rule | Prefix | Action | Apply now? |
|---|---|---|---|
| `vs-cards-safety-net` | `vs-cards/` | Delete 7 days after upload | Yes |
| `video-src-safety-net` | `video-src/` | Delete 2 days after upload | Yes |
| `stories-safety-net` | `stories/` | Delete 30 days after upload | **Not yet — see below** |

Both are safety nets under a cron that already deletes these on a 24-hour clock,
never the primary mechanism — a lifecycle rule cannot also clear the D1 row that
points at the object, so relying on one alone would leave rows referencing objects
that no longer exist.

**Do not add a lifecycle rule on `videos/`.** Encoded contest-entry videos are
kept indefinitely (match history), and story videos are deleted by the
story-expiry cron with their row. A prefix rule cannot tell the two apart.

**Hold the `stories/` rule until the video backfill is confirmed drained.** A
lifecycle rule is prefix-scoped and cannot consult `video_provider`. During the
backfill a story row deliberately keeps pointing at its R2 original until the
encode completes and promotes it, so a row stalled at `video_provider = 'migrating'`
(lost webhook, failed encode) still references an object in `stories/`. Deleting it
is silent and permanent. Check `GET /admin/videos/migration-status` reports no
pending rows first.

**Deliberately no rule on `deposits/` or `reports/`.** Those are the evidence
behind a manual money movement and a moderation decision. Deleting one while a
dispute or chargeback is open destroys the only proof of it, so a retention period
there is a finance/legal decision rather than a storage-cost one. Left to be made
explicitly.

## Qencode cutover runbook

Nothing here needs an app release beyond the build that contains the new upload
client. Do it on staging first: this path is tested against a fake Qencode API,
not against a real account.

**Prerequisites:**
1. A Qencode account and project. Copy the project's API key.
2. An R2 API token scoped to the media bucket, **Object Read & Write**. Qencode
   receives these keys with every job (it writes the output), so do not reuse an
   account-wide token.
3. **An R2 CORS rule on the media bucket** allowing `GET` and `HEAD` from the web
   app's origins (e.g. `https://tophunt.in`). hls.js fetches playlists and
   segments with XHR; without the rule, video does not play on the website.
   Native apps are unaffected.
4. The `video-src-safety-net` lifecycle rule above.

**Then, in the admin panel → Integrations:**
5. Video: enter the Qencode API key.
6. Storage: enter the R2 access key id and secret (and make sure `R2_ACCOUNT_ID`
   and `R2_BUCKET` are set on the Worker).
7. Video: set provider to **qencode** and press **Test** (checks the API key).

**Verify:**
8. `GET /health/deep` → `checks.media_routing.ok === true` with
   `"video: qencode (old app builds still use the raw R2 path)"`. If it reads *"config is
   incomplete"*, one of steps 5–6 is missing.
9. Post one story video from a current build. It should show "Processing…", then
   play. In R2 you should see `videos/<id>/playlist.m3u8` and `thumbnail.jpg`, and
   the row's `video-src/…` source should be gone. Check it plays on the website too (step 3).

**Old app builds:** a build from before Qencode does not send
`upload: "worker"`. It is answered "not configured" with `r2Fallback: true` and
keeps uploading a raw MP4 to R2 as it always did — it plays, without adaptive
bitrate. (Closing that path broke every old build's video posts in production
the moment the provider was switched.) Once no pre-Qencode build is in use, set
`r2AcceptsVideo: false` for `qencode-live` in `lib/mediaRouting.ts`.

**Rollback:** set provider back to **r2**. New uploads go to R2 on the next
request. Videos already encoded keep playing, because the app detects them by
the `.m3u8` in the stored URL.

**Then, optionally, the backfill** (`apps/admin-panel/scripts/migrate-videos-to-qencode.mjs`)
encodes existing raw R2 videos. Qencode pulls each original from R2 itself. Each
row is a billed encode, so check the volume with `--status` first. Do **not**
delete the R2 originals until the D1 rows have flipped to the encoded URLs.

## Deleting media: only the owner's

Every delete path (`deleteStory`, `deletePost`, the expired-story cron, account
deletion) goes through `deleteMediaByUrl(env, url, ownerUid)` in
`apps/worker/src/lib/mediaDelete.ts`.

A story or post holds a URL, not ownership: `createStory` accepts any URL, and
the app's Repost puts the original author's URL on a new story. Deleting by URL
alone deleted the author's photo or video when the repost was deleted or
expired. So the delete first checks who uploaded the object: R2
`customMetadata.uploader` (written by `POST /upload` since 2026-10-18) or, for
an encoded video, `videos.owner_uid`. An object recorded as another account's is kept. An object
with no record (older uploads) is deleted as before. The same lookup
(`mediaOwnership`) makes `startMatch`/`joinMatch` refuse another user's encoded
video, not only R2 photos.

An encoded video is a whole folder, so its delete is `deleteVideoObjects`: list
`videos/<id>/` and delete every key, plus any leftover raw source. Tests: `apps/worker/test/mediaOwnership.test.ts`.

When the original story expires its media goes, and a repost of it then shows
nothing: the author's lifecycle wins.

## Known gaps

- **Unattached uploads are never swept.** `videos.target_id` is never written,
  so an encoded video whose story or entry was never created stays in R2. R2 keeps no upload record at all. Fix:
  write `target_id` when the story or entry row is created, then add a sweep of
  ready/processing rows with no target older than 24 h, starting in report-only
  mode (a wrong delete loses user content).
- **Uploads do not survive an app restart.** No draft or upload state is
  persisted; a killed app restarts the upload from scratch.
- **R2 objects carry no stored Cache-Control.** `MEDIA.put` stores only the
  content type, so the custom domain serves whatever a zone rule sets. Check the
  dashboard.
- **Whole-video buffering, no resume.** The client reads the file into a Blob
  and the Worker buffers the body (80 MB cap). A dropped upload restarts from
  zero; see "The video pipeline" for why Qencode's resumable tus upload is not
  used.
- **Qencode has never run against a real account.** The pipeline is tested
  against a fake of Qencode's documented API. Unverified until staging: the
  `advanced_hls` output layout in R2 (master at `playlist.m3u8`), the `time`
  unit of the thumbnail, the `/v1/status` field names, the content types
  Qencode sets on R2 objects, and R2 accepting Qencode's S3 writes. **Do the
  cutover on staging first.**
- **A video deleted mid-encode can leak its output.** Deleting removes what is
  in `videos/<id>/` at that moment; a still-running job can write after it. The
  job is not cancelled.
- **No progressive MP4.** Only HLS is produced. Web plays it through hls.js; a
  browser with neither MSE nor native HLS cannot play video.
- **New contest banners bypass the `no-store` proxy.** `uploadToR2` writes them to
  `R2_PUBLIC_BASE_URL`, so a deleted banner can stay CDN-cached. Closing it needs
  an R2/zone cache rule for the `contest-banners/` prefix.
- **The R2 bucket has no CORS policy.** Only the web VS-card capture cares
  (`html-to-image` taints a canvas without it) and it degrades gracefully. See
  PRODUCTION_DOMAINS.md §6a.
- **A deleted battle card can stay cached.** `vs-cards/` is `immutable`, so
  although the cron deletes the object and nulls `vs_image_url` at 24 hours, a URL
  someone captured (the share sheet hands it to `downloadBattleImage`) may still be
  served from the edge for up to a year. `deleteVsImageByPublicUrl` does no colo
  purge, unlike the banner delete. Pre-existing; the fix is either `no-store` on
  that prefix or a purge in the delete path.
- **The `legacyVideo` branch is deletable after cutover.** Once provider is
  `qencode` in production and no build old enough to POST a video to `/upload` is
  installed, every `legacyVideo` flag, the branch in `allowedMimesForCategory` that
  reads it, and the R2 fallback in `uploadVideo.ts` go in one commit — along with
  `video/mp4` and `video/quicktime` from the R2 MIME allow-list.
