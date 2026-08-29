# Media architecture — images on R2, video on Bunny Stream

Companion to MEDIA_MIGRATION_PLAN.md, which is the historical plan. This is the
current design: what lives where, what the bucket looks like, and how to complete
or reverse the video cutover.

## The split

| Media | Store | Delivery |
|---|---|---|
| Images | Cloudflare R2 (`tophunt-media`) | `media.tophunt.in`, resized by Cloudflare Transformations |
| Video | Bunny Stream | Bunny pull zone — HLS on native, MP4 fallback on web |

Audio is in **neither**: story music previews are `musicTracks.previewUrl`, which
points at the externally hosted catalogue. There is no audio in the bucket and no
category for it — if that ever changes it needs a registry entry, or it will have
no cache policy and no lifecycle rule, which is the exact failure the registry
exists to prevent.

One module decides this and nothing else is allowed to:
**`apps/worker/src/lib/mediaRouting.ts`**. Its client mirror is
`apps/expo/src/services/media/uploadVideo.ts`.

### It is a switch, not a deletion

Bunny is not provisioned in this deployment yet, so removing the R2 video path
outright would leave no video path at all. Instead the split is enforced by
`integrations.video.provider`, which already existed:

| `provider` | Bunny config | Video goes to | R2 accepts video? | `media_routing` health |
|---|---|---|---|---|
| `bunny` | complete | **Bunny** | **No — rejected** | ok |
| `r2` | any | R2 (legacy) | Yes | ok, reported as legacy |
| `bunny` | incomplete | R2 (silent fallback) | Yes | **fails** |

The third row is the case worth naming: someone selected Bunny and did not finish
wiring it. Behaviour is identical to a deliberate legacy setup, so without a
distinct health signal a half-finished cutover looks like a working deployment
while the video library they think they are filling stays empty.

Both directions are an admin-panel setting — no deploy, no client release.
Rollback from a broken Bunny library has to be faster than a deploy.

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
| `vs-cards/` | user | immutable | 7 d | Composite battle cards; cron deletes at 24 h |
| `deposits/` | user | immutable | — | UPI screenshots. See the retention note below |
| `reports/` | user | immutable | — | Abuse-report evidence |
| `misc/` | user | immutable | — | Unclassified fallback |
| `contest-banners/` | **admin** | **no-store** | — | Has a real deletion lifecycle |
| `payment-qr/` | **admin** | immutable | — | Shown on the deposit screen |
| `blog/imported/` | **server** | immutable | — | Importer only; keyed by content hash |

`writer` is enforced: `POST /upload` derives its allow-list from
`writer === "user"`, so an admin- or server-owned prefix cannot be opened to
clients by omission. A user who could write `contest-banners/` could plant or
clobber a banner shown to everyone.

### Key layout

```
{prefix}/{YYYY}/{MM}/{uuid}{ext}      new uploads
blog/imported/{sha256}{ext}           content-hash keyed, deliberately NOT sharded
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
| `stories-safety-net` | `stories/` | Delete 30 days after upload | **Not yet — see below** |

Both are safety nets under a cron that already deletes these on a 24-hour clock,
never the primary mechanism — a lifecycle rule cannot also clear the D1 row that
points at the object, so relying on one alone would leave rows referencing objects
that no longer exist.

**Hold the `stories/` rule until the video backfill is confirmed drained.** A
lifecycle rule is prefix-scoped and cannot consult `video_provider`. During the
backfill a story row deliberately keeps pointing at its R2 original until the
encoding webhook promotes it, so a row stalled at `video_provider = 'migrating'`
(lost webhook, failed encode) still references an object in `stories/`. Deleting it
is silent and permanent. Check `GET /admin/videos/migration-status` reports no
pending rows first.

**Deliberately no rule on `deposits/` or `reports/`.** Those are the evidence
behind a manual money movement and a moderation decision. Deleting one while a
dispute or chargeback is open destroys the only proof of it, so a retention period
there is a finance/legal decision rather than a storage-cost one. Left to be made
explicitly.

## Bunny cutover runbook

Nothing here needs a deploy or an app release.

**Prerequisites, on the Bunny side:**
1. Create a Stream video library.
2. **Enable MP4 Fallback** on it. The web build has no native HLS and plays
   `play_720p.mp4`; without this those URLs 404.
3. Point the encoding webhook at `POST https://api.tophunt.in/webhook/bunny` and
   note the secret.

**Then, in the admin panel → Integrations → Video:**
4. Enter the API key and the webhook secret (encrypted credential store).
5. Enter the library id and the pull-zone hostname.
6. Set provider to **bunny**.

**Verify:**
7. `GET /health/deep` → `checks.media_routing.ok === true` with
   `"video: bunny (R2 refuses video)"`. If it reads *"config is incomplete"*, one
   of steps 4–5 is missing.
8. Upload one story video. It should appear in the Bunny library, and
   `POST /upload?fileType=video/mp4` should now return a `failed-precondition`
   naming `createVideoUpload`.

**Rollback:** set provider back to **r2**. Takes effect on the next request; R2
starts accepting video again immediately. Videos already in Bunny keep playing —
the client detects them by the `.m3u8` in the stored URL, so the two coexist with
no big-bang switch either way.

**Then, optionally, the backfill** (`apps/admin-panel/scripts/migrate-videos-to-bunny.mjs`)
moves existing R2 videos across. Bunny pulls from R2 itself, so nothing is
downloaded and re-uploaded. Do **not** delete the R2 originals until the D1 rows
have flipped to the Bunny URLs.

## Known gaps

- **Bunny has never run against a real account.** MEDIA_MIGRATION_PLAN.md is
  explicit that the whole Phase 2/3 path is type-checked and bundled but never
  executed. Unverified: TUS signature acceptance, the `VideoGuid`/`Status` webhook
  field names, `mapBunnyStatus` thresholds, fetch-from-URL. **Do the cutover on
  staging first.**
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
  `bunny` in production and no build old enough to POST a video to `/upload` is
  installed, every `legacyVideo` flag, the branch in `allowedMimesForCategory` that
  reads it, and the R2 fallback in `uploadVideo.ts` go in one commit — along with
  `video/mp4` and `video/quicktime` from the R2 MIME allow-list.
