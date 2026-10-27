/**
 * Server-owned VS Story publication for a two-player battle.
 *
 * ---------------------------------------------------------------------------
 * State machine (contest_matches.vs_story_*, migration 0055)
 * ---------------------------------------------------------------------------
 *
 *   match.status:      waiting_for_opponent ──join──▶ active ──▶ completed|ended|cancelled
 *   vs_story_status:   NULL ─────────────(same UPDATE)─▶ pending
 *                                                          │ claim (lease)
 *                                                          ▼
 *                       pending ◀── transient failure ── processing ── permanent ──▶ failed
 *                                                          │                          │
 *                                                          ▼ both stories confirmed   │ admin retry
 *                                                       published                     ▼
 *                                                                                  pending
 *   any non-terminal state while the match is no longer `active` ──▶ skipped
 *
 * `pending` is written ONLY by the joinMatch claim UPDATE, in the same D1
 * transaction that takes the joiner's fee — so the client can never declare a
 * match ready, and nothing but a real two-participant join enters this flow.
 *
 * ---------------------------------------------------------------------------
 * Recoverable workflow (nothing here pretends to be one transaction)
 * ---------------------------------------------------------------------------
 *   1. CLAIM      conditional UPDATE -> processing with a random lease token.
 *                 Concurrent callers (waitUntil after join, cron, a participant's
 *                 refresh) race on this one statement; exactly one wins.
 *   2. VERIFY     both participants distinct, present, joined, not deleted/banned,
 *                 not blocking each other; entries are OWNED media (R2 contest
 *                 prefixes, or a ready encoded video owned by that participant).
 *   3. COMPOSE    deterministic R2 key `vs-cards/battles/<matchId>-v<N>.jpg`. If an
 *                 object with matching customMetadata (match, both uids, render
 *                 version) is already there — an earlier attempt uploaded but died
 *                 before step 4 — it is REUSED, never duplicated or orphaned.
 *   4. PERSIST    vs_image_url/meta, gated on still holding the lease.
 *   5. STORIES    one D1 batch: two `INSERT OR IGNORE` rows with deterministic ids
 *                 (`contest_vs_story_<matchId>_<uid>`) and a unique index on
 *                 (match_id, user_id), both gated on lease + `status = 'active'`,
 *                 then the `published` flip, gated on BOTH rows existing.
 *   6. FAILURE    transient -> back to `pending` with exponential backoff;
 *                 permanent or exhausted -> `failed` (+ error log). Accepted entries
 *                 are never touched by any failure path.
 *
 * Money is deliberately NOT involved: entry fees, refunds and settlement keep
 * their own idempotency (lib/contestSettlement.ts). A render failure can delay a
 * story; it can never move a coin.
 */
import { and, eq, gt, inArray, lte, or, sql } from "drizzle-orm";
import type { Env } from "../types";
import { getDb, schema } from "../db";
import { now } from "./ids";
import { canonicalMediaUrl, deleteVsImageByPublicUrl, mediaKeyFromPublicUrl, vsImageKeyFromPublicUrl } from "./r2";
import { isSafeRelativeKey, VS_CARD_PREFIX } from "./mediaCategories";
import { sniffMediaMime, isImageMime } from "./mediaTypes";
import { thumbnailKey, videoIdFromUrl } from "./qencode";
import { isBlockedBetween } from "./blocks";
import { isHiddenAccountStatus } from "./accountStatus";
import { logErrorToDb } from "./observability";
import {
  imagesBindingRenderer,
  VS_RENDER_VERSION,
  VsMediaError,
  type VsRenderer,
} from "./vsComposite";

/** Story lifetime — the product's existing 24h story policy (createStory). */
export const STORY_TTL_MS = 24 * 60 * 60 * 1000;
/** A claim older than this is presumed dead and may be taken over. */
export const VS_LEASE_MS = 2 * 60 * 1000;
export const VS_MAX_ATTEMPTS = 8;
/** Bound on the whole render step (Images binding + R2 put). */
export const VS_RENDER_TIMEOUT_MS = 25_000;
/** Entry photos are client-downscaled; this is a generous ceiling, under the 20MB binding limit. */
export const VS_MAX_ENTRY_BYTES = 15 * 1024 * 1024;
export const VS_MAX_POSTER_BYTES = 5 * 1024 * 1024;

/** R2 prefixes a contest entry photo may live under (see mediaCategories). */
const ENTRY_PREFIXES = ["contests/", "contest-entries/"];

export type VsStoryStatus = "pending" | "processing" | "published" | "failed" | "skipped";

/** Client-facing projection, safe to put on public reads (no error details). */
export type PublicVsStoryStatus = "waiting_for_opponent" | "preparing" | "live" | "failed" | "unavailable";

export function publicVsStoryStatus(match: { status?: string | null; vsStoryStatus?: string | null }): PublicVsStoryStatus {
  if (match?.status === "waiting_for_opponent") return "waiting_for_opponent";
  switch (match?.vsStoryStatus) {
    case "pending":
    case "processing":
      return "preparing";
    case "published":
      return "live";
    case "failed":
      return "failed";
    default:
      return "unavailable";
  }
}

/**
 * Deterministic composite location. One object per battle, shared by both
 * stories. The render version is part of the key because the prefix is cached
 * `immutable`: a layout change must produce a new URL, never new bytes behind an
 * old one.
 */
export function vsCardKey(matchId: string): string {
  const key = `${VS_CARD_PREFIX}/battles/${matchId}-v${VS_RENDER_VERSION}.jpg`;
  if (!isSafeRelativeKey(key.slice(VS_CARD_PREFIX.length + 1))) throw new PermanentVsError("invalid_match_id");
  return key;
}

/** Deterministic story id: the `contest_vs_story:<matchId>:<uid>` idempotency key. */
export function vsStoryId(matchId: string, uid: string): string {
  return `contest_vs_story_${matchId}_${uid}`;
}

export class PermanentVsError extends Error {
  constructor(public readonly reason: string, message?: string) {
    super(message || reason);
  }
}
export class TransientVsError extends Error {
  constructor(public readonly reason: string, message?: string, public readonly delayMs?: number) {
    super(message || reason);
  }
}

export type VsRunOutcome =
  | "published"
  | "already_published"
  | "busy"
  | "not_eligible"
  | "skipped"
  | "retry_scheduled"
  | "failed";

export interface VsRunResult {
  outcome: VsRunOutcome;
  reason?: string;
}

export interface VsRunOptions {
  /** Override the renderer (tests, alternative backends). Defaults to env.IMAGES. */
  renderer?: VsRenderer | null;
  /** Clock override for tests. */
  nowMs?: number;
  /** Render-step bound override (tests). Defaults to VS_RENDER_TIMEOUT_MS. */
  renderTimeoutMs?: number;
}

export function defaultVsRenderer(env: Env): VsRenderer | null {
  return env.IMAGES ? imagesBindingRenderer(env.IMAGES) : null;
}

/** 30s, 60s, 2m, 4m … capped at 1h. */
export function vsBackoffMs(attempts: number): number {
  return Math.min(60 * 60 * 1000, 30_000 * 2 ** Math.max(0, attempts - 1));
}

const randomToken = () => crypto.randomUUID();

async function withTimeout<T>(p: Promise<T>, ms: number, reason: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new TransientVsError(reason, `${reason} after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Trusted input resolution
// ---------------------------------------------------------------------------

interface Participant {
  uid: string;
  username: string;
  avatarUrl: string;
  isPrivate: boolean;
  snapshot: any;
}

async function loadParticipants(env: Env, match: any): Promise<[Participant, Participant]> {
  const a = match.userA as any;
  const b = match.userB as any;
  if (!a?.uid || !b?.uid) throw new PermanentVsError("missing_participant");
  if (String(a.uid) === String(b.uid)) throw new PermanentVsError("same_participant");
  if (!match.joinIdA || !match.joinIdB) throw new PermanentVsError("incomplete_join");
  if (b.joinId && b.joinId !== match.joinIdB) throw new PermanentVsError("join_mismatch");

  const rows = await getDb(env)
    .select({
      uid: schema.users.uid,
      username: schema.users.username,
      avatar: schema.users.profileImageUrl,
      status: schema.users.status,
      isBlocked: schema.users.isBlocked,
      isPrivate: schema.users.isPrivate,
    })
    .from(schema.users)
    .where(inArray(schema.users.uid, [String(a.uid), String(b.uid)]))
    .all();
  const byUid = new Map(rows.map((r) => [r.uid, r]));
  const toParticipant = (snap: any): Participant => {
    const row = byUid.get(String(snap.uid));
    // A deleted, pending-deletion or banned account gets no new story, and its
    // face must not be put on the other participant's reel either.
    if (!row || isHiddenAccountStatus(row.status) || row.isBlocked) {
      throw new PermanentVsError("participant_unavailable");
    }
    return {
      uid: row.uid,
      username: row.username || snap.username || "player",
      avatarUrl: canonicalMediaUrl(env, row.avatar) || "",
      isPrivate: !!row.isPrivate,
      snapshot: snap,
    };
  };
  const pa = toParticipant(a);
  const pb = toParticipant(b);
  // joinMatch refuses a blocked pair, but a block can land after the join.
  if (await isBlockedBetween(env, pa.uid, pb.uid)) throw new PermanentVsError("participants_blocked");
  return [pa, pb];
}

async function readR2Entry(env: Env, url: string, ownerUid: string): Promise<{ key: string; bytes: Uint8Array }> {
  const key = mediaKeyFromPublicUrl(env, url);
  const prefix = key ? ENTRY_PREFIXES.find((p) => key.startsWith(p)) : undefined;
  if (!key || !prefix || !isSafeRelativeKey(key.slice(prefix.length))) {
    throw new PermanentVsError("untrusted_media", "entry is not an owned contest upload");
  }
  let obj: R2ObjectBody | null;
  try {
    obj = await env.MEDIA.get(key);
  } catch (e: any) {
    throw new TransientVsError("r2_read_failed", e?.message);
  }
  if (!obj) throw new PermanentVsError("media_missing");
  // Provenance recorded by POST /upload. An entry uploaded by a DIFFERENT account
  // is never composited onto this participant's Story. Objects predating that
  // metadata carry none and are accepted (see VS_STORY_LIFECYCLE.md, limitations).
  const uploader = (obj as any).customMetadata?.uploader;
  if (uploader && uploader !== ownerUid) {
    throw new PermanentVsError("untrusted_media", "entry was uploaded by another account");
  }
  if (typeof (obj as any).size === "number" && (obj as any).size > VS_MAX_ENTRY_BYTES) {
    throw new PermanentVsError("media_too_large");
  }
  const bytes = new Uint8Array(await new Response((obj as any).body).arrayBuffer());
  if (bytes.length > VS_MAX_ENTRY_BYTES) throw new PermanentVsError("media_too_large");
  const mime = sniffMediaMime(bytes);
  if (!mime || !isImageMime(mime)) throw new PermanentVsError("unsupported_format", `entry sniffed as ${mime ?? "unknown"}`);
  return { key, bytes };
}

/**
 * The poster frame of a participant's encoded video — only once that video is
 * `ready`, only if it belongs to that participant, and read straight from our
 * bucket (`videos/<id>/thumbnail.jpg`), never from a URL. No poster, no card:
 * we never invent one.
 */
async function readVideoPoster(env: Env, url: string, ownerUid: string): Promise<{ key: string; bytes: Uint8Array }> {
  const videoId = videoIdFromUrl(env, url);
  if (!videoId) throw new PermanentVsError("video_poster_unavailable", "entry is not an encoded video");
  const video = await getDb(env).select().from(schema.videos).where(eq(schema.videos.id, videoId)).get();
  if (!video || video.ownerUid !== ownerUid) throw new PermanentVsError("untrusted_media", "video is not owned by participant");
  if (video.status === "failed") throw new PermanentVsError("video_failed");
  if (video.status !== "ready") throw new TransientVsError("video_not_ready", undefined, 5 * 60 * 1000);
  const key = thumbnailKey(videoId);
  let obj: R2ObjectBody | null;
  try {
    obj = await env.MEDIA.get(key);
  } catch (e: any) {
    throw new TransientVsError("poster_fetch_failed", e?.message);
  }
  if (!obj) throw new PermanentVsError("video_poster_unavailable");
  if (typeof (obj as any).size === "number" && (obj as any).size > VS_MAX_POSTER_BYTES) {
    throw new PermanentVsError("media_too_large");
  }
  const bytes = new Uint8Array(await new Response((obj as any).body).arrayBuffer());
  if (bytes.length > VS_MAX_POSTER_BYTES) throw new PermanentVsError("media_too_large");
  const mime = sniffMediaMime(bytes);
  if (!mime || !isImageMime(mime)) throw new PermanentVsError("unsupported_format");
  return { key, bytes };
}

async function resolveEntry(env: Env, match: any, p: Participant): Promise<{ key: string; bytes: Uint8Array }> {
  const url = p.snapshot?.mediaUrl;
  if (!url || typeof url !== "string") throw new PermanentVsError("media_missing");
  const isVideoContest = match.type === "video";
  const isVideoEntry = p.snapshot?.mediaType === "video";
  // Never silently treat one kind of battle as the other.
  if (isVideoContest !== isVideoEntry) throw new PermanentVsError("media_type_mismatch");
  return isVideoContest ? readVideoPoster(env, url, p.uid) : readR2Entry(env, url, p.uid);
}

// ---------------------------------------------------------------------------
// The workflow
// ---------------------------------------------------------------------------

/**
 * Run (or resume) publication for one battle. Safe to call any number of times,
 * concurrently, from anywhere; only a caller that wins the claim does work.
 * Never throws — every outcome is a result.
 */
export async function runVsPublication(env: Env, matchId: string, opts: VsRunOptions = {}): Promise<VsRunResult> {
  const ts = opts.nowMs ?? now();
  const token = randomToken();

  let claimed = 0;
  try {
    const res = await env.DB.prepare(
      `UPDATE contest_matches
          SET vs_story_status = 'processing', vs_story_claim = ?, vs_story_claimed_at = ?,
              vs_story_attempts = vs_story_attempts + 1
        WHERE id = ? AND status = 'active'
          AND ((vs_story_status = 'pending' AND COALESCE(vs_story_next_at, 0) <= ?)
            OR (vs_story_status = 'processing' AND COALESCE(vs_story_claimed_at, 0) <= ?))`,
    )
      .bind(token, ts, matchId, ts, ts - VS_LEASE_MS)
      .run();
    claimed = Number(res.meta?.changes || 0);
  } catch (e) {
    console.error("[vsPublication] claim failed", matchId, e);
    return { outcome: "retry_scheduled", reason: "claim_failed" };
  }

  if (!claimed) return explainUnclaimed(env, matchId, ts);

  try {
    return await publishClaimed(env, matchId, token, ts, opts);
  } catch (e: any) {
    return recordFailure(env, matchId, token, ts, e);
  }
}

async function explainUnclaimed(env: Env, matchId: string, ts: number): Promise<VsRunResult> {
  const m = await getDb(env)
    .select({
      status: schema.contestMatches.status,
      vsStoryStatus: schema.contestMatches.vsStoryStatus,
      claimedAt: schema.contestMatches.vsStoryClaimedAt,
    })
    .from(schema.contestMatches)
    .where(eq(schema.contestMatches.id, matchId))
    .get();
  if (!m || !m.vsStoryStatus) return { outcome: "not_eligible" };
  if (m.vsStoryStatus === "published") return { outcome: "already_published" };
  if (m.vsStoryStatus === "failed") return { outcome: "failed" };
  if (m.vsStoryStatus === "skipped") return { outcome: "skipped" };
  // Still pending/processing but the battle is over (settled, cancelled,
  // refunded): it must never gain a VS Story now. A live lease is left to its
  // owner, whose gated writes will refuse and route here on the next pass.
  if (m.status !== "active") {
    const res = await env.DB.prepare(
      `UPDATE contest_matches
          SET vs_story_status = 'skipped', vs_story_claim = NULL, vs_story_claimed_at = NULL, vs_story_next_at = NULL
        WHERE id = ? AND status != 'active'
          AND (vs_story_status = 'pending'
            OR (vs_story_status = 'processing' AND COALESCE(vs_story_claimed_at, 0) <= ?))`,
    )
      .bind(matchId, ts - VS_LEASE_MS)
      .run();
    return Number(res.meta?.changes || 0) > 0 ? { outcome: "skipped" } : { outcome: "busy" };
  }
  return { outcome: "busy" };
}

/**
 * Step 3 of both the publication workflow and on-demand share regeneration:
 * produce the ONE canonical composite for a battle at its deterministic key.
 *
 * Reuses a verified existing object (same match, both uids, render version) and
 * otherwise renders once from trusted entries. `stillOwner` is consulted right
 * before the only write that SQL cannot gate (the R2 put); returning false
 * aborts with `null` so a caller that lost its claim writes nothing.
 */
async function produceComposite(
  env: Env,
  match: any,
  pa: Participant,
  pb: Participant,
  ts: number,
  opts: VsRunOptions,
  stillOwner: () => Promise<boolean>,
): Promise<{ publicUrl: string; meta: Record<string, unknown> } | null> {
  const matchId = String(match.id);
  const key = vsCardKey(matchId);
  const publicUrl = `${env.R2_PUBLIC_BASE_URL.replace(/\/$/, "")}/${key}`;

  let head: R2Object | null = null;
  try {
    head = await env.MEDIA.head(key);
  } catch (e: any) {
    throw new TransientVsError("r2_head_failed", e?.message);
  }
  const cm = (head as any)?.customMetadata || {};
  if (head && cm.matchId === matchId && cm.uidA === pa.uid && cm.uidB === pb.uid && Number(cm.version) === VS_RENDER_VERSION) {
    return { publicUrl, meta: { ...cm, reused: true, key } };
  }

  const renderer = opts.renderer === undefined ? defaultVsRenderer(env) : opts.renderer;
  if (!renderer) throw new TransientVsError("renderer_unavailable", "IMAGES binding is not configured", 30 * 60 * 1000);
  const [ea, eb] = await Promise.all([resolveEntry(env, match, pa), resolveEntry(env, match, pb)]);
  if (ea.key === eb.key) throw new PermanentVsError("duplicate_media");
  let out;
  try {
    out = await withTimeout(
      renderer.render({
        left: { bytes: ea.bytes, username: pa.username },
        right: { bytes: eb.bytes, username: pb.username },
        title: match.title || "Battle",
        kind: match.type === "video" ? "video" : "photo",
      }),
      opts.renderTimeoutMs ?? VS_RENDER_TIMEOUT_MS,
      "render_timeout",
    );
  } catch (e: any) {
    if (e instanceof VsMediaError) throw new PermanentVsError(e.reason, e.message);
    throw e instanceof TransientVsError ? e : new TransientVsError("render_failed", e?.message);
  }
  const customMetadata = {
    matchId,
    uidA: pa.uid,
    uidB: pb.uid,
    version: String(VS_RENDER_VERSION),
    renderer: renderer.id,
    generatedAt: String(ts),
  };
  // A caller that lost its claim during a slow render must not replace the
  // bytes behind a URL that is cached `immutable`.
  if (!(await stillOwner())) return null;
  try {
    await env.MEDIA.put(key, out.bytes, { httpMetadata: { contentType: out.contentType }, customMetadata });
  } catch (e: any) {
    throw new TransientVsError("r2_put_failed", e?.message);
  }
  return {
    publicUrl,
    meta: { ...customMetadata, key, width: out.width, height: out.height, bytes: out.bytes.length, labels: out.labels },
  };
}

/** Keep the composite while voting runs, plus a grace window for sharing. */
export const VS_IMAGE_RETAIN_MS = 7 * 24 * 60 * 60 * 1000;

async function publishClaimed(env: Env, matchId: string, token: string, ts: number, opts: VsRunOptions): Promise<VsRunResult> {
  const db = getDb(env);
  const match = await db.select().from(schema.contestMatches).where(eq(schema.contestMatches.id, matchId)).get();
  if (!match || match.status !== "active") throw new PermanentVsError("match_not_active");

  const [pa, pb] = await loadParticipants(env, match);

  // --- 3. composite: reuse a verified earlier upload, else render once --------
  const produced = await produceComposite(env, match, pa, pb, ts, opts, async () =>
    !!(await env.DB.prepare(`SELECT 1 AS ok FROM contest_matches WHERE id = ? AND vs_story_claim = ? AND status = 'active'`)
      .bind(matchId, token)
      .first<{ ok: number }>()),
  );
  if (!produced) return lostLeaseOrSkipped(env, matchId, token, ts);
  const { publicUrl, meta } = produced;

  // --- 4. persist the reference, only while we still own the lease ----------
  // Retained through the voting window (+ grace) so feed/profile/battle-link
  // sharing keeps resolving to the same image after the 24h Stories expire.
  const retainUntil = Math.max(Number(match.expiresAt || 0), ts + STORY_TTL_MS) + VS_IMAGE_RETAIN_MS;
  const persisted = await env.DB.prepare(
    `UPDATE contest_matches SET vs_image_url = ?, vs_image_meta = ?,
            vs_image_retain_until = MAX(COALESCE(vs_image_retain_until, 0), ?)
      WHERE id = ? AND vs_story_claim = ? AND status = 'active'`,
  )
    .bind(publicUrl, JSON.stringify(meta), retainUntil, matchId, token)
    .run();
  if (!Number(persisted.meta?.changes || 0)) return lostLeaseOrSkipped(env, matchId, token, ts);

  // --- 5. both stories + the published flip, one batch ----------------------
  // A pair shares one timestamp. If an earlier partial run left one row, the
  // other adopts its window so the two never expire apart.
  const existing = await db
    .select({ createdAt: schema.stories.createdAt, expiresAt: schema.stories.expiresAt })
    .from(schema.stories)
    .where(and(eq(schema.stories.matchId, matchId), eq(schema.stories.type, "contest_vs")))
    .get();
  const createdAt = existing?.createdAt ?? ts;
  const expiresAt = existing?.expiresAt ?? ts + STORY_TTL_MS;
  const contestTitle = match.title || "Contest";
  const gate = `EXISTS (SELECT 1 FROM contest_matches WHERE id = ? AND vs_story_claim = ? AND status = 'active')`;
  const insertStory = (p: Participant) =>
    env.DB.prepare(
      `INSERT OR IGNORE INTO stories
         (id, user_id, username, avatar_url, media_url, media_type, visibility, type, match_id, contest_title, created_at, expires_at)
       SELECT ?, ?, ?, ?, ?, 'image', ?, 'contest_vs', ?, ?, ?, ?
        WHERE ${gate}`,
    ).bind(
      vsStoryId(matchId, p.uid),
      p.uid,
      p.username,
      p.avatarUrl,
      publicUrl,
      // Mirrors what the account already presents: a private account's contest
      // story is followers-only, like the composer's default; otherwise public,
      // like the battle itself in the feed.
      p.isPrivate ? "followers" : "public",
      matchId,
      contestTitle,
      createdAt,
      expiresAt,
      matchId,
      token,
    );

  const results = await env.DB.batch([
    insertStory(pa),
    insertStory(pb),
    // Pre-0055 rows: the solo "come challenge me" story is wrong once a VS exists.
    env.DB.prepare(
      `DELETE FROM stories WHERE match_id = ? AND type = 'contest_announcement' AND ${gate}`,
    ).bind(matchId, matchId, token),
    env.DB.prepare(
      `UPDATE contest_matches
          SET vs_story_status = 'published', vs_story_published_at = ?, vs_story_claim = NULL,
              vs_story_claimed_at = NULL, vs_story_next_at = NULL, vs_story_error = NULL
        WHERE id = ? AND vs_story_claim = ? AND status = 'active'
          AND (SELECT COUNT(*) FROM stories
                WHERE match_id = ? AND type = 'contest_vs' AND user_id IN (?, ?)) = 2`,
    ).bind(ts, matchId, token, matchId, pa.uid, pb.uid),
  ]);
  if (Number(results[3]?.meta?.changes || 0) === 1) return { outcome: "published" };
  return lostLeaseOrSkipped(env, matchId, token, ts);
}

async function lostLeaseOrSkipped(env: Env, matchId: string, token: string, ts: number): Promise<VsRunResult> {
  // Still our lease but the battle ended under us: release it as `skipped` now
  // rather than leaving it `processing` until the lease times out.
  const released = await env.DB.prepare(
    `UPDATE contest_matches
        SET vs_story_status = 'skipped', vs_story_claim = NULL, vs_story_claimed_at = NULL, vs_story_next_at = NULL
      WHERE id = ? AND vs_story_claim = ? AND status != 'active'`,
  )
    .bind(matchId, token)
    .run();
  if (Number(released.meta?.changes || 0) > 0) return { outcome: "skipped" };
  const r = await explainUnclaimed(env, matchId, ts);
  return r.outcome === "not_eligible" ? { outcome: "busy" } : r;
}

async function recordFailure(env: Env, matchId: string, token: string, ts: number, e: any): Promise<VsRunResult> {
  const permanent = e instanceof PermanentVsError;
  const reason: string = e?.reason || "unexpected_error";
  let attempts = VS_MAX_ATTEMPTS;
  try {
    const row = await getDb(env)
      .select({ attempts: schema.contestMatches.vsStoryAttempts })
      .from(schema.contestMatches)
      .where(eq(schema.contestMatches.id, matchId))
      .get();
    attempts = Number(row?.attempts ?? VS_MAX_ATTEMPTS);
  } catch {
    /* fall through as exhausted */
  }
  const exhausted = !permanent && attempts >= VS_MAX_ATTEMPTS;
  // The battle ended under us: that is not a fault to repair, just ineligible.
  const finalStatus = reason === "match_not_active" ? "skipped" : permanent || exhausted ? "failed" : "pending";
  const nextAt = finalStatus === "pending" ? ts + Math.max(vsBackoffMs(attempts), Number(e?.delayMs || 0)) : null;
  const errorText = `${exhausted ? "retries_exhausted:" : ""}${reason}${e?.message && e.message !== reason ? `: ${String(e.message).slice(0, 300)}` : ""}`;
  try {
    await env.DB.prepare(
      `UPDATE contest_matches
          SET vs_story_status = ?, vs_story_claim = NULL, vs_story_claimed_at = NULL,
              vs_story_next_at = ?, vs_story_error = ?
        WHERE id = ? AND vs_story_claim = ?`,
    )
      .bind(finalStatus, nextAt, errorText, matchId, token)
      .run();
  } catch (writeErr) {
    // The lease will expire and the cron will take it again.
    console.error("[vsPublication] could not record failure", matchId, writeErr);
  }
  if (finalStatus === "skipped") return { outcome: "skipped", reason };
  console.error("[vsPublication]", finalStatus === "failed" ? "FAILED" : "retry scheduled", matchId, errorText);
  if (finalStatus === "failed") {
    await logErrorToDb(env, new Error(`VS story publication failed for match ${matchId}: ${errorText}`), {
      path: "vsPublication",
      tags: { matchId, reason },
    });
    return { outcome: "failed", reason };
  }
  return { outcome: "retry_scheduled", reason };
}

/**
 * Cron reconciliation: drive every due pending publication and reclaim expired
 * leases. Bounded per tick; the rest are picked up next tick.
 */
export async function reconcileVsPublications(
  env: Env,
  opts: VsRunOptions & { limit?: number } = {},
): Promise<{ attempted: number; published: number; failed: number }> {
  const ts = opts.nowMs ?? now();
  const limit = Math.max(1, Math.min(50, opts.limit ?? 10));
  const due = await getDb(env)
    .select({ id: schema.contestMatches.id })
    .from(schema.contestMatches)
    .where(
      or(
        and(
          eq(schema.contestMatches.vsStoryStatus, "pending"),
          lte(sql`COALESCE(${schema.contestMatches.vsStoryNextAt}, 0)`, ts),
        ),
        and(
          eq(schema.contestMatches.vsStoryStatus, "processing"),
          lte(sql`COALESCE(${schema.contestMatches.vsStoryClaimedAt}, 0)`, ts - VS_LEASE_MS),
        ),
      ),
    )
    .limit(limit)
    .all();
  let published = 0;
  let failed = 0;
  for (const { id } of due) {
    const r = await runVsPublication(env, id, opts);
    if (r.outcome === "published") published++;
    if (r.outcome === "failed") failed++;
  }
  return { attempted: due.length, published, failed };
}

/**
 * Admin repair: put a failed (or stuck) publication back in the queue. Never
 * touches a published one, and never revives a match that is no longer active.
 */
export async function requeueVsPublication(env: Env, matchId: string): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE contest_matches
        SET vs_story_status = 'pending', vs_story_attempts = 0, vs_story_next_at = 0,
            vs_story_claim = NULL, vs_story_claimed_at = NULL
      WHERE id = ? AND status = 'active' AND user_b IS NOT NULL
        AND vs_story_status IN ('failed', 'pending', 'processing')`,
  )
    .bind(matchId)
    .run();
  return Number(res.meta?.changes || 0) > 0;
}

// ---------------------------------------------------------------------------
// Canonical share asset
// ---------------------------------------------------------------------------

export type ShareImageStatus = "ready" | "preparing" | "waiting_for_opponent" | "unavailable";

export interface ShareImageResult {
  matchId: string;
  status: ShareImageStatus;
  /** The canonical composite — present only when `status === 'ready'`. */
  url: string | null;
  kind: "photo" | "video";
  /** Safe failure category for `unavailable` (no error text, no paths). */
  reason?: string;
  /**
   * `unavailable` because the RENDERER failed transiently, not because sharing
   * is refused — the client may fall back to a card it draws itself.
   */
  retryable?: boolean;
}

/**
 * True when `url` is a SERVER-rendered card of THIS match, of any render
 * version. Accepting every version matters: after a layout bump, live Stories
 * still point at the older `-v<N>` object, which is still trustworthy (we
 * rendered it) and must be neither replaced nor deleted out from under them.
 */
export function isCanonicalVsUrl(env: Env, url: string | null | undefined, matchId: string): boolean {
  if (!url) return false;
  const base = env.R2_PUBLIC_BASE_URL.replace(/\/$/, "");
  const prefix = `${base}/${VS_CARD_PREFIX}/battles/${matchId}-v`;
  return url.startsWith(prefix) && /^\d+\.jpg$/.test(url.slice(prefix.length));
}

/** Only extend retention when less than this remains (avoids a D1 write per read). */
const RETAIN_EXTEND_BELOW_MS = 6 * 24 * 60 * 60 * 1000;

/**
 * SQL gate for share-time regeneration writes: still our claim, the battle was
 * not taken down, and neither participant has been deleted, banned or had their
 * entry purged since the render started. Without it a cancel or an account
 * deletion landing mid-render would be undone by this write.
 */
const REGEN_GATE = `
  id = ? AND vs_story_claim = ? AND status != 'cancelled'
  AND json_extract(user_a, '$.mediaUrl') IS NOT NULL
  AND json_extract(user_b, '$.mediaUrl') IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM users u
     WHERE u.uid IN (json_extract(user_a, '$.uid'), json_extract(user_b, '$.uid'))
       AND (u.is_blocked = 1 OR u.status IN ('deleted', 'pending_deletion'))
  )`;

/**
 * The one image every share path for a two-player battle must use.
 *
 * Verifies the stored composite still exists (R2 lifecycle or the cleanup sweep
 * may have removed it) and, when it is missing, regenerates it at the SAME
 * deterministic key under a short claim — never touching Stories, the
 * publication state, ownership or money. While publication is still running the
 * answer is `preparing`; the caller polls. Callers never get a participant's
 * raw entry from here.
 *
 * `beforeRegenerate` runs only when a render may be needed (the caller's
 * per-battle cost limit); plain reads never consume it.
 */
export async function ensureMatchShareImage(
  env: Env,
  matchId: string,
  opts: VsRunOptions & { beforeRegenerate?: () => Promise<void> } = {},
): Promise<ShareImageResult> {
  const ts = opts.nowMs ?? now();
  const db = getDb(env);
  const match = await db.select().from(schema.contestMatches).where(eq(schema.contestMatches.id, matchId)).get();
  const kind: "photo" | "video" = match?.type === "video" ? "video" : "photo";
  const result = (status: ShareImageStatus, extra: Partial<ShareImageResult> = {}): ShareImageResult => ({
    matchId,
    status,
    url: null,
    kind,
    ...extra,
  });
  if (!match) return result("unavailable", { reason: "not_found" });
  const uidA = (match.userA as any)?.uid;
  const uidB = (match.userB as any)?.uid;
  if (match.status === "waiting_for_opponent" || !uidB) return result("waiting_for_opponent");
  if (!uidA) return result("unavailable", { reason: "missing_participant" });
  if (match.status === "cancelled") return result("unavailable", { reason: "cancelled" });
  if (match.vsStoryStatus === "pending" || match.vsStoryStatus === "processing") {
    if (match.status === "active") return result("preparing");
    // The battle is over but its publication never ran (or its lease expired):
    // it can never publish now. Retire it inline instead of answering
    // "preparing" and leaving that to a background pass, so the share image can
    // be resolved on THIS request. A live lease is still left to its owner.
    if ((await explainUnclaimed(env, matchId, ts)).outcome !== "skipped") return result("preparing");
    match.vsStoryStatus = "skipped";
  }

  const currentRetain = Number(match.vsImageRetainUntil || 0);
  const extend = Math.max(currentRetain, ts + VS_IMAGE_RETAIN_MS);
  // Only a SERVER-rendered card is canonical. A legacy client-captured card
  // (pre-0055, arbitrary pixels from one participant) is replaced, not served.
  if (match.vsImageUrl && isCanonicalVsUrl(env, match.vsImageUrl, matchId)) {
    const key = vsImageKeyFromPublicUrl(env, match.vsImageUrl);
    let exists = false;
    try {
      exists = !!(key && (await env.MEDIA.head(key)));
    } catch {
      return result("unavailable", { reason: "storage_unavailable" });
    }
    if (exists) {
      if (currentRetain - ts < RETAIN_EXTEND_BELOW_MS) {
        await db.update(schema.contestMatches).set({ vsImageRetainUntil: extend }).where(eq(schema.contestMatches.id, matchId)).run();
      }
      return result("ready", { url: match.vsImageUrl });
    }
  }

  if (opts.beforeRegenerate) {
    try {
      await opts.beforeRegenerate();
    } catch {
      return result("unavailable", { reason: "rate_limited" });
    }
  }

  // Regenerate under a short claim on the (idle) publication lease, so two
  // viewers sharing at once render once and Stories are never involved.
  const token = randomToken();
  const claimed = await env.DB.prepare(
    `UPDATE contest_matches SET vs_story_claim = ?, vs_story_claimed_at = ?
      WHERE id = ? AND status != 'cancelled'
        AND COALESCE(vs_story_status, '') NOT IN ('pending', 'processing')
        AND (vs_story_claim IS NULL OR COALESCE(vs_story_claimed_at, 0) <= ?)`,
  )
    .bind(token, ts, matchId, ts - VS_LEASE_MS)
    .run();
  if (!Number(claimed.meta?.changes || 0)) return result("preparing");
  const release = () =>
    env.DB.prepare(`UPDATE contest_matches SET vs_story_claim = NULL, vs_story_claimed_at = NULL WHERE id = ? AND vs_story_claim = ?`)
      .bind(matchId, token)
      .run();
  const gateOk = async () =>
    !!(await env.DB.prepare(`SELECT 1 AS ok FROM contest_matches WHERE ${REGEN_GATE}`).bind(matchId, token).first<{ ok: number }>());
  try {
    const [pa, pb] = await loadParticipants(env, match);
    const produced = await produceComposite(env, match, pa, pb, ts, opts, gateOk);
    if (!produced) {
      await release().catch(() => {});
      return result("unavailable", { reason: "no_longer_shareable" });
    }
    const saved = await env.DB.prepare(
      `UPDATE contest_matches
          SET vs_image_url = ?, vs_image_meta = ?, vs_image_retain_until = ?,
              vs_story_claim = NULL, vs_story_claimed_at = NULL
        WHERE ${REGEN_GATE}`,
    )
      .bind(produced.publicUrl, JSON.stringify({ ...produced.meta, regeneratedFor: "share" }), extend, matchId, token)
      .run();
    if (!Number(saved.meta?.changes || 0)) {
      // Lost the claim to publication (which reuses this same object): fine.
      // But if the battle was taken down or a participant left during the
      // render, the object we just wrote must not survive at a public url.
      const after = await db
        .select({ status: schema.contestMatches.status, claim: schema.contestMatches.vsStoryClaim })
        .from(schema.contestMatches)
        .where(eq(schema.contestMatches.id, matchId))
        .get();
      if (!after || after.claim === token || after.status === "cancelled") {
        await env.MEDIA.delete(vsCardKey(matchId)).catch(() => {});
        await release().catch(() => {});
        return result("unavailable", { reason: "no_longer_shareable" });
      }
      return result("preparing");
    }
    // The superseded LEGACY client card (never a server card) is referenced by
    // nothing once no live Story names it.
    if (match.vsImageUrl && match.vsImageUrl !== produced.publicUrl && !isCanonicalVsUrl(env, match.vsImageUrl, matchId)) {
      const stillShown = await db
        .select({ id: schema.stories.id })
        .from(schema.stories)
        .where(and(eq(schema.stories.mediaUrl, match.vsImageUrl), gt(schema.stories.expiresAt, ts)))
        .limit(1)
        .get();
      if (!stillShown) await deleteVsImageByPublicUrl(env, match.vsImageUrl).catch(() => {});
    }
    return result("ready", { url: produced.publicUrl });
  } catch (e: any) {
    await release().catch(() => {});
    const reason: string = e?.reason || "render_failed";
    const detail = `${reason}${e?.message && e.message !== reason ? `: ${String(e.message).slice(0, 300)}` : ""}`;
    console.error("[vsShare] could not resolve share image", matchId, detail);
    // Record WHY, where an admin can see it. This path used to only log to the
    // console, so a renderer failing for every battle was invisible: every share
    // answered "preparing" forever and nothing anywhere said what was wrong.
    // `vs_story_error` is shown per match in the admin panel; the error log is
    // the cross-battle view. The status column is deliberately not touched.
    await env.DB.prepare(`UPDATE contest_matches SET vs_story_error = ? WHERE id = ?`)
      .bind(`share_regen:${detail}`, matchId)
      .run()
      .catch(() => {});
    await logErrorToDb(env, new Error(`VS share image render failed for match ${matchId}: ${detail}`), {
      path: "vsShare",
      tags: { matchId, reason },
    });
    if (e instanceof TransientVsError) {
      // A transient RENDER failure is not "preparing": nothing is in flight, and
      // answering "preparing" made clients poll and wait indefinitely. Report it
      // as unavailable-but-retryable so a client can draw its own card now; the
      // next request (per-battle regen limit permitting) renders again.
      return result("unavailable", { reason, retryable: true });
    }
    return result("unavailable", { reason });
  }
}
