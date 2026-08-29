# Media Migration Plan — R2 for photos, Bunny Stream for video

Written 2026-08-23 against commit `3bb480d`.

**Goal:** every image served from Cloudflare R2, every video served from Bunny Stream.

**Important starting point:** photos are *already* on R2, and so are videos. This is
therefore not a "move to R2" project — it is (a) finish and fix the existing R2 setup,
and (b) move video off R2 onto Bunny Stream.

---

# 1. Current state (verified)

All media flows through one path:

```
client → POST /upload (Worker, requireAuth) → uploadToR2() → env.MEDIA.put() → R2
```

Key layout: `{folder}/{images|videos}/{uuid}{ext}` (`apps/worker/src/lib/r2.ts:111`).

| Folder | Content | Upload site |
|---|---|---|
| `avatars` | profile photos | `app/auth/signup/fill-profile`, `app/auth/signup/congratulations`, `app/profile/manage/edit` |
| `stories` | photo **and video** | `app/story/create/index.tsx:257` |
| `contests` | photo **and video** entries | `app/contest/photo/setup.tsx`, `app/contest/video/index.tsx` via `src/services/contests/uploadMedia.ts` |
| `deposits` | UPI payment screenshots | `app/wallet/deposit.tsx:64` |
| `contest-banners` | admin banners | admin panel |
| blog images | imported posts | `scripts/archive-import/import.mjs` |

Client upload helper: `apps/expo/src/lib/uploadToR2.ts` (was `uploadToS3.ts` — the
name was legacy, it posts to the Worker, not S3; renamed during implementation). Allowed MIME types (`lib/r2.ts:13`): `image/jpeg`, `image/png`,
`image/gif`, `image/webp`, `video/mp4`, `video/quicktime`. Hard cap 80 MB
(`routes/upload.ts:23`).

Video playback today uses `expo-video` pointed straight at the R2/Worker URL, in six
places: `app/contest/video/index.tsx`, `app/story/create/index.tsx`,
`app/story/view/[userId].tsx`, `app/story/highlight/[userId].tsx`, and
`src/components/home/PostCard.tsx` (`VideoMedia`). No transcoding, no adaptive
bitrate, one resolution, no generated thumbnails.

---

# 2. Three problems found in the current setup

## 2.1 `/media/*` has no HTTP Range support

`apps/worker/src/index.ts:105-146` serves R2 objects with a plain
`env.MEDIA.get(key)`. It never reads the `Range` request header and never returns
`206 Partial Content` or `Accept-Ranges` (confirmed by grep — zero matches for
`range`, `onlyIf`, `206` in `index.ts` and `lib/r2.ts`).

Consequences:

- **Seeking / scrubbing in video does not work**
- The whole file is fetched on every play
- iOS `AVPlayer` expects range requests and behaves unreliably without them

This is the single strongest technical reason to move video to Bunny.

## 2.2 `R2_PUBLIC_BASE_URL` points at the Worker itself

> **Status: addressed in config.** `R2_PUBLIC_BASE_URL` is now
> `https://media.tophunt.in` and `R2_LEGACY_BASE_URLS` carries the base below, so
> the delete paths still recognise pre-cutover urls. The R2 custom domain itself is
> a dashboard step — see `PRODUCTION_DOMAINS.md` §3 and the backfill in §5. The
> analysis below is what the problem was.

`wrangler.toml [vars]`, before:

```toml
R2_PUBLIC_BASE_URL = "https://tophunt-api.weadown-in.workers.dev/media"
```

Every media byte is proxied through the Worker. That spends Worker invocations and
CPU time on static file serving, and bypasses the custom-domain path where R2 egress
is free.

## 2.3 Image optimization is fully built but unused, and cannot work yet

> **RESOLVED.** Both problems below are fixed and Transformations is live.
> Problem 1 is stale: the Expo client now reads the variant fields in ~10 places
> (`PostCard.tsx`, `leaderboard.tsx`, `StoryItem.tsx`, `connections.tsx`,
> `blog/index.tsx`, `vsStory.ts`, …), each with an `|| mediaUrl` fallback.
> Problem 2 is fixed by the domain: `MEDIA_TRANSFORMATIONS = "true"`, verified on
> production by the `cf-resized: … f=true` response header. Two things were also
> found while enabling it, both now fixed:
>
> - Urls on a legacy base were excluded from optimisation *permanently*, because
>   `imgVariant` only matched the current base. They are now canonicalised first
>   (`lib/r2.ts#canonicalMediaUrl`), so optimisation no longer waits on the manual
>   D1 backfill.
> - The presets used `fit=cover`, which **upscales** a source narrower than the
>   target. On a real 645x1440 portrait entry the 1080 preset was 84,436 B vs
>   50,638 B with `scale-down` — 67% larger and blurrier, on the most common shape
>   in a DP contest. All three presets now use `scale-down`.
>
> See `PRODUCTION_DOMAINS.md` §6.

`apps/worker/src/lib/media.ts` provides `thumbUrl` (320px), `optimizedUrl` (1080px)
and `avatarUrl` (128px), and `routes/read.ts` attaches the results as
`mediaUrlThumb`, `mediaUrlOptimized`, `profileImageUrlThumb` and `imageThumb` in 12+
places (lines 337, 505, 641, 653, 722, 753, 993, 1050, 1138, 1361, …).

Two problems:

1. **The Expo client consumes none of these fields** — grep for `mediaUrlThumb`,
   `mediaUrlOptimized`, `profilePicThumb` across `apps/expo/app` and
   `apps/expo/src` returns zero hits.
2. They would not work anyway. The URLs are of the form
   `{base}/cdn-cgi/image/width=320,.../{path}`, and `/cdn-cgi/image/` requires
   Cloudflare **Transformations** enabled on the serving zone. A `workers.dev`
   hostname is not such a zone, so the path would simply 404.

So this is dead weight today. Both halves are missing: a proper domain, and client
adoption.

---

# Phase 0 — Custom domain for media (foundation)

Everything else depends on this.

1. Attach a custom domain (e.g. `media.tophunt.in`) to the `tophunt-media` R2 bucket
   in the Cloudflare dashboard.
2. Update `wrangler.toml`:
   ```toml
   R2_PUBLIC_BASE_URL = "https://media.tophunt.in"
   ```
3. **Enable Transformations on that zone.** This is what makes the existing
   `/cdn-cgi/image/` code in `lib/media.ts` actually resolve.
4. Keep the `/media/*` Worker route in place — old DB rows contain `workers.dev`
   URLs and must keep resolving. Do not delete it.

This alone fixes 2.2 and unblocks 2.3.

Also worth doing here: add Range support to `/media/*` for the legacy videos that
will still be served from R2 during the migration window. R2's `get()` accepts a
`range` option and the response needs `Accept-Ranges: bytes` plus a `206` status.

---

# Phase 1 — Photos: finish the R2 setup

## 1a. Remove external image hosts

These are still fetched from third parties:

| Host | Occurrences | Used as |
|---|---|---|
| `ui-avatars.com` | 12 in `apps/expo`, plus `read.ts:1415` | avatar fallback |
| `via.placeholder.com` | 3 | image placeholder |
| `i.pravatar.cc` | 1 | avatar placeholder |

Replace with a local initials-avatar component (SVG, rendered client-side) or a
single default avatar object stored in R2.

Reasons beyond tidiness: `ui-avatars.com` URLs embed the username, so every avatar
render leaks a username to a third party; and the fallback silently breaks on poor
connectivity, which is exactly when it is needed.

## 1b. Make the client use the thumbnail variants

Switch feeds, grids and avatar rows to `mediaUrlThumb` / `profileImageUrlThumb`, and
keep the full-resolution URL for detail views only. The server side already emits
these fields — this is a client-only change, and the bandwidth difference is large
(320px vs. original camera resolution).

## 1c. Normalize images on upload

`POST /upload` currently stores whatever the client sends, so a 12 MB phone photo is
stored and served at full size. Add a max-dimension cap and WebP/AVIF conversion at
upload time in `apps/worker/src/routes/upload.ts`.

---

# Phase 2 — Video: move to Bunny Stream

Core design rule: **the Bunny API key never reaches the app.** The Worker mints
short-lived signed credentials; the client uploads directly to Bunny. Bunny's own docs
are explicit about this — "Never expose your API key in client-side code."

## 2a. Bunny setup

1. Create a Video Library → gives `libraryId` + an API key.
2. Note the pull-zone hostname (`vz-xxxx.b-cdn.net`).
3. **Enable MP4 Fallback** — required for the web build (see 2f).
4. Choose the **Volume** delivery network, not Standard. For an India-heavy audience
   Standard is $0.030/GB (Asia & Oceania) while Volume is $0.005/GB up to 500 TB.
   That is a 6x difference.

## 2b. New secrets

```bash
wrangler secret put BUNNY_STREAM_API_KEY
wrangler secret put BUNNY_LIBRARY_ID
```

Plus `BUNNY_CDN_HOSTNAME` in `wrangler.toml [vars]` (not secret).

**Add all three to `apps/worker/.dev.vars.example`.** The Razorpay secrets are
currently missing from that file (see audit finding #13) — do not repeat it.

## 2c. D1 schema

New migration `apps/worker/migrations/0017_bunny_video.sql`. A URL is no longer
sufficient, because processing is asynchronous:

```sql
ALTER TABLE contest_matches ADD COLUMN video_provider TEXT;       -- 'r2' | 'bunny'
ALTER TABLE contest_matches ADD COLUMN bunny_video_id TEXT;
ALTER TABLE contest_matches ADD COLUMN video_status TEXT;         -- uploading|processing|ready|failed
ALTER TABLE contest_matches ADD COLUMN video_thumbnail_url TEXT;
ALTER TABLE contest_matches ADD COLUMN video_duration_sec INTEGER;
```

Same columns on the stories table. Update `apps/worker/src/db/schema.ts` to match.

`video_provider` is what allows old R2 videos and new Bunny videos to coexist, so no
big-bang cutover is needed.

**Constraint:** keep this migration DDL-only and idempotent. `autoMigrate.ts` runs
without a distributed lock (audit finding #15), so a data backfill inside a migration
can execute more than once. Do backfills as explicit admin actions instead.

## 2d. New Worker endpoints

### `POST /api` action `createVideoUpload`

Two steps, both server-side:

1. Create the video object:
   ```
   POST https://video.bunnycdn.com/library/{libraryId}/videos
   Header: AccessKey: {BUNNY_STREAM_API_KEY}
   Body:   { "title": "..." }
   → returns { guid: "..." }
   ```
2. Compute the TUS signature:
   ```
   SHA256(libraryId + apiKey + expirationTime + videoId)   // hex
   ```
   Order matters: library id, api key, expiry, video guid.

Return to the client: `{ videoId, libraryId, expirationTime, signature }`.

Set `expirationTime` to **at least 3600s** (Bunny's own recommendation). On slow
Indian mobile networks even a 30s clip can take a while, and a mid-upload expiry
produces a `401`.

Rate-limit this action — otherwise anyone can create unlimited video objects in your
Bunny account:

```ts
await rateLimit(env, `vidup:${uid}`, 10, 3600);
```

### `POST /webhook/bunny`

Bunny calls this when encoding finishes. Set `video_status = 'ready'`, store the
thumbnail URL and duration, and notify the user.

Follow the existing pattern in `apps/worker/src/routes/webhook.ts`: read the **raw
body first**, verify the signature over those exact bytes, and acknowledge with `200`
even on internal failure so Bunny stops retrying. That file already does this
correctly for Razorpay.

### Deletion

Wherever a story or contest entry is deleted, the Bunny video must be deleted too:

```
DELETE https://video.bunnycdn.com/library/{libraryId}/videos/{guid}
```

Today `deleteByPublicUrl()` (`lib/r2.ts:159`) only handles R2. Missing this means
storage cost grows silently forever.

## 2e. Client — upload

Add `tus-js-client`. Flow:

```
createVideoUpload (Worker)  →  { videoId, libraryId, expirationTime, signature }
  ↓
tus upload → https://video.bunnycdn.com/tusupload
  headers:  AuthorizationSignature, AuthorizationExpire, LibraryId, VideoId
  metadata: filetype (MIME) + title    ← both mandatory
  ↓
uploadComplete (Worker) → bunny_video_id + video_status = 'processing'
```

Bonus that does not exist today: TUS is **resumable**. Use
`findPreviousUploads()` + `resumeFromPreviousUpload()` so a dropped connection
resumes instead of restarting. Suggested `retryDelays: [0, 3000, 5000, 10000, 20000, 60000]`.

## 2f. Client — playback

**Native (iOS / Android):** HLS plays directly. `expo-video` uses AVPlayer on iOS and
ExoPlayer on Android, both of which support HLS natively. Bunny publishes a guide for
exactly this setup.

```
https://{BUNNY_CDN_HOSTNAME}/{videoId}/playlist.m3u8
```

This gives adaptive bitrate — 240p up to 1080p selected automatically from the
viewer's bandwidth. Compared to the current single-resolution R2 file, this is the
biggest user-visible win of the whole migration, especially on Indian mobile data.

**Web:** Chrome does not support HLS natively. Two options:

1. Use the **MP4 Fallback** URL (why it is enabled in 2a)
2. Use Bunny's iframe embed when `Platform.OS === 'web'`

Recommendation: MP4 fallback. All six existing `expo-video` call sites keep working
unchanged — only the URL differs. The iframe route would mean rewriting
`VideoMedia` in `src/components/home/PostCard.tsx:55` and the story viewers.

**New UI state to handle:** `processing`. Today a video is playable the instant upload
finishes; with Bunny there is roughly 10-60s of encoding. Show the thumbnail with a
"Processing…" overlay and subscribe to `video_status`. The `live()` helper in
`apps/expo/src/services/realtime.ts` already does exactly this kind of subscription.

---

# Phase 3 — Backfill existing R2 videos

Admin-only script: `apps/admin-panel/scripts/migrate-videos-to-bunny.mjs`, following
the pattern of the existing scripts in that directory (they authenticate to the Worker
with `ADMIN_PROXY_SECRET`).

Bunny supports **fetch-from-URL**, so there is no need to download and re-upload —
hand Bunny the R2 URL and it pulls the file itself.

```
1. SELECT rows WHERE video_provider IS NULL AND <video column> IS NOT NULL
2. For each: create Bunny video object → trigger fetch from the R2 URL
3. UPDATE row SET bunny_video_id = ..., video_provider = 'bunny', video_status = 'processing'
4. Do NOT delete the R2 object yet
```

Run in batches, make it resumable (it can be re-run safely because of the
`video_provider IS NULL` filter), and delete the R2 originals only after ~30 days of
confirmed playback. The `video_provider` column means the app keeps working against
both sources throughout.

---

# Phase 4 — Cleanup

- Remove `video/mp4` and `video/quicktime` from `ALLOWED_MIME_TYPES`
  (`apps/worker/src/lib/r2.ts:13`). Without this, clients keep uploading video down
  the old path.
- With video gone, the 80 MB cap in `routes/upload.ts:23` applies to images only and
  can drop to ~15 MB.
- Add a per-user Bunny upload quota and a cost alert on the Bunny account.

---

# Cost estimate

Bunny Stream rates as of 2026-08-23:

| Item | Rate |
|---|---|
| Storage | $0.01/GB/month (default region) |
| Delivery — Volume network | $0.005/GB up to 500 TB |
| Delivery — Standard, Asia & Oceania | $0.030/GB |
| Standard encoding | **free** |
| Premium encoding (1080p/720p) | $0.050 per output minute |
| Minimum monthly fee | none |

Rough projection for 10,000 contest videos × 30s × ~5 MB average:

- Storage ≈ 50 GB → **~$0.50/month**
- Delivery at 500 GB served/month on Volume → **~$2.50/month**

Cost is not the constraint here. Use **Standard** encoding (free) — Premium is billed
per output minute and buys nothing this app needs. The real return on this migration is
adaptive bitrate, working range requests, and generated thumbnails, none of which exist
today.

---

# Open decisions

1. **Custom domain** — does one exist, or does it need registering? Phase 0 is
   half-blocked without it, and Phase 1b/2.3 cannot work at all.
2. **Scope of video migration** — contest entries and stories together, or contest
   first? Recommendation: contest first (longer, higher-stakes videos), stories after.
3. **Public or signed video URLs?** Contest entries are public, so no token auth
   needed. Stories are arguably private and would need Bunny's embed-view token
   authentication (HMAC-SHA256, `token` + `expires` query params).
4. **How much does the web build matter?** If little, skip MP4 Fallback and ship
   HLS-only for native.

---

# Blocked on

**Update 2026-08-23: the code blockers are cleared.** See "Remediation status" in
`AUDIT_2026-08-23.md`. All three of the following are fixed and verified — the web
bundle builds, the expo app type-checks clean, and stories are functional again:

- ~~The web bundle does not build (duplicate `nextStory` in
  `app/story/view/[userId].tsx`)~~
- ~~`storyService.ts` has broken imports, so stories are non-functional~~
- ~~`app/story/view/[userId].tsx:26` imports `PreloadVideo` from `expo-video`, which
  does not export it~~ — replaced with `createVideoPlayer` plus a `release()` in the
  effect cleanup. Worth knowing before Phase 2f: that call site is now the app's
  only video *preloading* path, and Bunny's HLS URLs will need the same treatment.

What remains blocking is **external provisioning, not code**:

1. **Phase 0 needs a real custom domain** attached to the `tophunt-media` R2 bucket,
   with Cloudflare Transformations enabled on that zone. Until then the
   `/cdn-cgi/image/` URLs in `lib/media.ts` cannot resolve and Phase 1b is moot.
   The host is `media.tophunt.in` (an earlier revision of this file said
   `media.tophuntdpcontest.com`, which was never the plan). The config now points
   at it and the D1 backfill is written; connecting the domain and enabling
   Transformations on the zone remain dashboard actions — `PRODUCTION_DOMAINS.md`
   §3, §5 and §6.
2. **Phase 2 needs a Bunny Stream account** (library id + API key + pull-zone
   hostname) before any of `2a`–`2f` can be built or tested.

Also note that audit finding #15 (no distributed lock in `autoMigrate`) is
**unresolved by design** — it is now documented as a constraint in
`apps/worker/README.md`. The Phase 2c warning about keeping `0017_bunny_video.sql`
DDL-only and idempotent therefore still applies exactly as written.

---

# Reference links

- [TUS resumable uploads](https://bunny.net/docs/stream/tus-resumable-uploads)
- [Stream HTTP API](https://bunny.net/docs/stream/http-api)
- [Create video](https://bunny.net/docs/api-reference/stream/manage-videos/create-video)
- [MP4 Fallback](https://bunny.net/docs/stream/mp4-downloads)
- [Native video playback with Bunny Stream + Expo](https://bunny.net/blog/native-video-playback-with-bunny-stream-and-expo/)
- [Embed view token authentication](https://bunny.net/docs/stream/token-authentication)
- [Stream pricing](https://bunny.net/docs/stream/pricing)
- [Delivery tiers](https://bunny.net/docs/stream/delivery-tiers)



---

# Implementation status — 2026-08-23

Everything below was verified by running the toolchain. What could **not** be
verified is stated plainly at the end.

| Check | Result |
|---|---|
| `apps/worker` typecheck / tests / dry-run build | clean / 19✅ / passes |
| `apps/expo` typecheck / tests / web bundle | clean / 14✅ 3 skipped / builds |
| `apps/admin-panel` typecheck / build | clean / passes |

## Shipped and active immediately

| Phase | Item | Where |
|---|---|---|
| 0 | **HTTP Range support on `/media/*`** — 206, `Content-Range`, `Accept-Ranges`, `HEAD`, and 416 for an unsatisfiable range. This is §2.1, the strongest technical item in this plan: video seeking now works and iOS `AVPlayer` gets the range requests it expects. | `worker/src/lib/httpRange.ts`, `worker/src/index.ts` |
| 1a | **All external image hosts removed** — 19 call sites. `ui-avatars.com`, `via.placeholder.com`, `i.pravatar.cc` are gone; a local `<Avatar>` renders initials with a stable per-name colour. | `expo/src/components/ui/Avatar.tsx` + 18 files |

Two notes on Range: ranged requests deliberately **bypass the edge Cache API**,
because storing a 206 under the full-URL cache key would poison it with a partial
body. And R2 is handed the request headers directly so it applies the RFC parsing
and clamping rules itself.

## Shipped, dormant until provisioning

These are complete and type-checked but intentionally inert, so they were safe to
merge before the accounts exist.

| Phase | Item | Activation |
|---|---|---|
| 1b | Variant fields (`mediaUrlThumb` / `mediaUrlOptimized` / `profileImageUrlThumb` / `avatarUrlThumb`) adopted across feeds, grids and avatar rows | set `MEDIA_TRANSFORMATIONS = "true"` |
| 2b/2c | `videos` table + `video_provider` markers (migration `0017`), Bunny config plumbing | `wrangler secret put BUNNY_STREAM_API_KEY` / `BUNNY_LIBRARY_ID`, set `BUNNY_CDN_HOSTNAME` |
| 2d | `createVideoUpload`, `videoUploadComplete`, `videoStatus`, `POST /webhook/bunny`, provider-aware deletion | same as above |
| 2e | TUS resumable upload with `findPreviousUploads` / `resumeFromPreviousUpload` | same as above |
| 2f | HLS on native, MP4 fallback on web, `Processing…` overlay | same as above |
| 3 | `migrate-videos-to-bunny.mjs` + `POST /admin/videos/migrate-batch` | same as above |

**Phase 1b is gated on the server, not the client.** While
`MEDIA_TRANSFORMATIONS` is off, `imgVariant()` returns the *original* URL, so
every variant field simply equals the full-size URL. That is what made client
adoption safe to do now: flipping the flag at cutover turns them into real
resized URLs with no client release.

`transformationsAvailable()` also refuses to enable on a `*.workers.dev` host or
on a base URL with a path prefix. **That second condition is why the existing
variant URLs never worked** — `/cdn-cgi/image/` only resolves at a zone *root*,
and `R2_PUBLIC_BASE_URL` ends in `/media`. §2.3 attributed this to Transformations
being disabled; the path prefix was the other half.

**Everything Bunny is fail-closed.** With the secrets unset, `createVideoUpload`
returns `{ configured: false }` and the client falls back to the existing R2
upload path; `POST /webhook/bunny` returns 503. So this deploys safely today and
switches on with secrets alone.

## Corrections to this plan

**§2c put the video columns on the wrong table.** `contest_matches` holds *two*
participants in its `user_a` / `user_b` JSON, each with their own media, so single
`bunny_video_id` / `video_status` columns cannot represent a match's videos.

Implemented instead as a **`videos` table keyed by Bunny's guid**. Two benefits
beyond correctness: the encoding webhook becomes a primary-key update rather than
a search across every table that might own a video, and because a Bunny playback
URL is `https://{host}/{guid}/playlist.m3u8`, the guid is recoverable from the
existing `mediaUrl` — so **no participant-JSON migration was needed at all**.

**§3's backfill would have broken playback.** As written it repoints the row at
Bunny at enqueue time, but a Bunny video is unplayable for the ~10-60s it is
encoding. The implementation leaves `mediaUrl` on R2 and lets the `ready` webhook
perform the cutover (`promoteBackfilledVideo`), which is what actually delivers
the plan's "app keeps working against both sources throughout".

**Deletion was a wider leak than §2d implied.** `deleteByPublicUrl()` is called
from three places, not one — and the one that matters most is the **cron expired-
story sweep**, since stories expire every 24h. An R2-only delete there would have
orphaned a Bunny video per story, forever. All three now route through
`deleteMediaByUrl()`.

**§2f's "subscribe to `video_status`" is implemented as client-driven polling.**
Rather than joining the `videos` table into all six read endpoints, the client
extracts the guid from a Bunny URL and polls the `videoStatus` action only for
videos it can actually see, and only until they report ready or failed.

## Not done

- ~~**Phase 0 steps 1-3**~~ — **DONE.** `media.tophunt.in` is attached and serving
  (`curl -I` = 200), `R2_PUBLIC_BASE_URL` points at it, Transformations is enabled
  on the zone and `MEDIA_TRANSFORMATIONS = "true"`. Verified against production
  rather than assumed — the `cf-resized` response header is the proof. The D1
  backfill (`scripts/media-domain-backfill.sql`) is still worth running, but it is
  no longer a prerequisite for delivery: the read path canonicalises legacy urls
  onto the media domain, so the backfill is data hygiene now. `PRODUCTION_DOMAINS.md`
  §5 and §6.
- **Phase 1c** — now **done client-side** instead. The plan put the max-dimension
  cap on `POST /upload`, but a Worker cannot resize an image without
  Transformations or the Images binding, both of which are blocked on the domain
  work. So it moved to the client: `apps/expo/src/lib/imageOptimize.ts` downscales
  and recompresses before upload, per target (avatar 512px, story 1920px, contest
  1440px, deposit 1600px). WebP/AVIF conversion is still outstanding — the Worker
  already accepts `image/webp`, but `expo-image-manipulator`'s WEBP support is not
  reliably cross-platform, so uploads stay JPEG (which is what every one of these
  paths already declared anyway).
- **Phase 4** (drop `video/mp4` + `video/quicktime` from `ALLOWED_MIME_TYPES`,
  lower the 80 MB cap to ~15 MB) — deliberately deferred. Doing it now would break
  all video upload, since the R2 path is still the active one until Bunny is
  provisioned. Do this only after cutover is confirmed.
- **Bunny-side setup** (2a): create the library, **enable MP4 Fallback** (the web
  build has no native HLS and depends on it), pick the **Volume** delivery tier —
  for an India-heavy audience Standard is $0.030/GB vs Volume $0.005/GB — and keep
  **Standard (free)** encoding.
- Signed/token-authenticated story videos (open decision #3). Contest entries are
  public so they need nothing; story privacy would need Bunny embed-view tokens.
- Per-user Bunny upload quota and a cost alert. The `createVideoUpload` rate limit
  (10/hour/user) is in place, but there is no account-level spend guard.

## Unverified

No Bunny account was available, so the entire Phase 2/3 path is **type-checked and
bundled but never executed**. Specifically unexercised: the TUS signature is
accepted by Bunny, the webhook payload field names match (`VideoGuid`, `Status`),
`mapBunnyStatus`'s thresholds match real encode states, and fetch-from-URL works
against an R2 URL. Treat the first real upload as the integration test, and run
`migrate-videos-to-bunny.mjs --limit=1` before any bulk run.

Range support was verified only by typecheck and build, not against real R2
objects — worth confirming with `curl -H 'Range: bytes=0-1' -i` on a deployed
video, which should return `206` plus `Content-Range`.


---

# Media performance pass — 2026-08-23

Follow-up work targeting perceived speed in stories and feeds. Four changes, all
client-side, all verified by typecheck + tests + web bundle.

## What was actually wrong

The starting assumption was "images and videos re-download every time". That was
only half right, and the half that was wrong mattered:

- **Images were already disk-cached.** `expo-image` defaults to
  `cachePolicy: 'disk'`, and `/media/*` sends
  `Cache-Control: public, max-age=31536000, immutable` against content-hash keys.
  Nothing was re-downloading.
- **Videos genuinely were re-downloading**, but not for the expected reason.
  `VideoSource.useCaching` defaults to **`false`** in expo-video, and every call
  site passed a bare URL string — so the cache was never populated no matter what
  size it was set to. (The default cache *budget* is already 1 GB, not zero.)
- **The real image problem was byte size, not caching.** Uploads stored whatever
  the picker returned — a modern camera photo is 3-8 MB at 4000x3000 — because the
  only guard on `POST /upload` is an 80 MB cap.
- **Nothing was ever preloaded**, so opening a story always began with a cold
  fetch against a blank screen.

## Changes

| # | Change | Effect |
|---|---|---|
| 1 | `src/lib/imageOptimize.ts` — downscale + recompress before upload, per target | The largest single win. 4000x3000 → 1080x1440 is a ~12x pixel reduction before compression. |
| 2 | `videoSourceFor()` sets `useCaching: true`; `configureVideoCache()` sets a 256 MB budget | Videos stop re-downloading. Budget trimmed from expo-video's 1 GB default. |
| 3 | `src/lib/mediaPrefetch.ts` — warm story images ahead of the user | Tapping a story opens on a cached frame. |
| 4 | `src/components/ui/AppImage.tsx` — one place for `cachePolicy` / `recyclingKey` / `transition` | `cachePolicy` was set on only 3 of 9 call sites; `recyclingKey` stops recycled rows flashing the previous image. |

Notes worth keeping in mind when touching this code:

- `setVideoCacheSizeAsync` **throws once any `VideoPlayer` exists**, which is why
  `configureVideoCache()` runs at module scope in `app/_layout.tsx` rather than in
  an effect.
- expo-video **cannot cache HLS on iOS**. Bunny videos there fall back to
  AVPlayer's own buffering; adaptive bitrate is the win on that path anyway.
- Prefetching spends the user's data, so `prefetchImages` budgets by
  `isConnectionExpensive` (6 normal / 2 metered) and de-duplicates per session.
  expo-image has no prefetch cancellation, which is the other reason the budget is
  small.
- `optimizeImageForUpload` returns the **original URI** on any failure, so a
  manipulation error can never block a user's upload.

## Still outstanding

- **WebP/AVIF on upload** — would save a further ~25-30%. Blocked on reliable
  cross-platform WEBP support in `expo-image-manipulator`.
- **Blurhash placeholders** — needs a hash computed at upload and stored on the
  row; `expo-image` supports `placeholder={{ blurhash }}`.
- **react-query persistence** — the query cache is memory-only, so a cold start
  refetches every list. An AsyncStorage persister would show the last feed
  instantly.
- **A "Clear cache" action** — `clearVideoCache()` and `videoCacheSize()` exist and
  are unused; they need a settings screen, and `clearVideoCacheAsync` only works
  when no player is active.
- ~~**Flipping `MEDIA_TRANSFORMATIONS`**~~ — **DONE**, see "Not done" above and
  `PRODUCTION_DOMAINS.md` §6. Remaining media work is now: run the D1 backfill
  (hygiene), decide on an R2/zone cache rule for `contest-banners/images/` (new
  uploads bypass the proxy's `no-store`), and re-import the blog images the
  importer left on Wayback/`i0.wp.com`, which no backfill can move.
