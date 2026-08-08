/**
 * VoteCounter — a SQLite-backed Durable Object that owns the authoritative
 * high-frequency write state for ONE contest match (idFromName(matchId)):
 *   - vote tallies (per participant) + per-voter dedup/audit
 *   - engagement counters (likes, comments, shares, reactions)
 *   - batched vote XP for voters
 *
 * Callers talk to it via native Durable Object RPC — plain method calls on the
 * stub (stub.vote(...), stub.engagement(...)) — so there are no fake internal
 * URLs or fetch() plumbing.
 *
 * Why this exists
 * ---------------
 * D1 has a single writer for the whole database. The naive path updated the
 * SAME `contest_matches` row on every vote / like / reaction, plus a per-vote
 * users XP write. Under a viral battle thousands of writers contend on one hot
 * row and starve every other write in the app (wallet, chat, ...). That is the
 * classic single-writer bottleneck.
 *
 * This DO removes those writes from the hot request path:
 *   - Dedup + all counters happen in the DO's own local SQLite (strongly
 *     consistent, serialized per match, microsecond-fast, contention-free).
 *   - An alarm batches the accumulated state back into D1 every FLUSH_MS, so
 *     N events become ~1 D1 write per window instead of N.
 *   - Vote XP is accumulated and applied to `users` in one batched UPDATE per
 *     flush instead of a read+write per vote.
 *
 * Migration / cold start correctness
 * -----------------------------------
 * On first touch the DO SEEDS itself from D1 — existing `votes` rows (who voted)
 * and the current `contest_matches` counters — so matches that already had
 * activity keep their counts AND dedup guard. Counters are flushed back as
 * ABSOLUTE values (idempotent); the DO is the sole writer of these columns
 * after seeding.
 *
 * The Worker verifies auth / status / participant rules BEFORE calling this DO,
 * so — like RealtimeHub — the DO trusts its caller.
 */
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";

/** How long events accumulate in the DO before being batch-written to D1. */
const FLUSH_MS = 5_000;
/** XP awarded per (new) vote — matches the previous inline awardXp(uid, 5). */
const VOTE_XP = 5;
/** Max uids per IN(...) chunk when batching XP updates. */
const XP_CHUNK = 40;

export interface VoteInput {
  matchId: string;
  voterUid: string;
  votedForUid: string;
  deviceId?: string | null;
  uidA?: string | null;
  uidB?: string | null;
}

export interface VoteTally {
  alreadyVoted: boolean;
  /** True when this device already voted in the match (multi-account abuse). */
  deviceUsed: boolean;
  votesA: number;
  votesB: number;
  total: number;
}

export interface VoteTotals {
  votesA: number;
  votesB: number;
  total: number;
}

export class VoteCounter extends DurableObject<Env> {
  private sql: SqlStorage;
  private voteSeedPromise: Promise<void> | null = null;
  private engSeedPromise: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // Local (DO-owned) SQLite schema. Idempotent, cheap.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);`);
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS voters (
         voter_uid     TEXT PRIMARY KEY,
         voted_for_uid TEXT NOT NULL,
         device_id     TEXT,
         created_at    INTEGER NOT NULL,
         flushed       INTEGER NOT NULL DEFAULT 0,
         xp_awarded    INTEGER NOT NULL DEFAULT 0
       );`,
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS tallies (
         uid   TEXT PRIMARY KEY,
         votes INTEGER NOT NULL DEFAULT 0
       );`,
    );
    // Engagement counters: name -> value. name is "like" | "comment" | "share"
    // | "react:<type>".
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS counters (
         name  TEXT PRIMARY KEY,
         value INTEGER NOT NULL DEFAULT 0
       );`,
    );
  }

  // ============================ RPC methods ================================

  /** Cast a vote. Dedup + tally are authoritative inside the DO. */
  async vote(p: VoteInput): Promise<VoteTally> {
    await this.ensureVoteSeeded(p.matchId, p.uidA ?? null, p.uidB ?? null);

    const existing = this.sql
      .exec("SELECT 1 FROM voters WHERE voter_uid = ? LIMIT 1", p.voterUid)
      .toArray();
    if (existing.length > 0) {
      return { alreadyVoted: true, deviceUsed: false, ...this.voteTally() };
    }

    // Anti-fraud: a single device may vote only once per match — blocks
    // multi-account vote stuffing from the same phone.
    if (p.deviceId) {
      const dev = this.sql
        .exec("SELECT 1 FROM voters WHERE device_id = ? LIMIT 1", p.deviceId)
        .toArray();
      if (dev.length > 0) {
        return { alreadyVoted: false, deviceUsed: true, ...this.voteTally() };
      }
    }

    const ts = Date.now();
    this.sql.exec(
      "INSERT INTO voters (voter_uid, voted_for_uid, device_id, created_at, flushed, xp_awarded) VALUES (?, ?, ?, ?, 0, 0)",
      p.voterUid,
      p.votedForUid,
      p.deviceId ?? null,
      ts,
    );
    this.sql.exec(
      "INSERT INTO tallies (uid, votes) VALUES (?, 1) ON CONFLICT(uid) DO UPDATE SET votes = votes + 1",
      p.votedForUid,
    );

    await this.scheduleFlush();
    return { alreadyVoted: false, deviceUsed: false, ...this.voteTally() };
  }

  /**
   * Bump an engagement counter. `name` is "like" | "comment" | "share" |
   * "react:<type>"; `delta` may be negative (clamped at 0). Returns counters.
   */
  async engagement(
    matchId: string,
    name: string,
    delta: number,
  ): Promise<Record<string, number>> {
    await this.ensureEngagementSeeded(matchId);
    const d = Number(delta) || 0;
    this.sql.exec(
      `INSERT INTO counters (name, value) VALUES (?, MAX(?, 0))
         ON CONFLICT(name) DO UPDATE SET value = MAX(value + ?, 0)`,
      name,
      d,
      d,
    );
    await this.scheduleFlush();
    return this.counterMap();
  }

  /** Force a synchronous flush to D1 and return the authoritative vote tally. */
  async flushTally(matchId: string, uidA?: string | null, uidB?: string | null): Promise<VoteTotals> {
    await this.ensureVoteSeeded(matchId, uidA ?? null, uidB ?? null);
    await this.flush();
    return this.voteTally();
  }

  /** Read-only current vote tally (seeds if needed). */
  async tally(matchId: string, uidA?: string | null, uidB?: string | null): Promise<VoteTotals> {
    await this.ensureVoteSeeded(matchId, uidA ?? null, uidB ?? null);
    return this.voteTally();
  }

  // --------------------------------------------------------------------- seed
  private async ensureVoteSeeded(
    matchId: string | undefined,
    uidA: string | null,
    uidB: string | null,
  ): Promise<void> {
    if (this.getMeta("voteSeeded") === "1") {
      if (uidA && !this.getMeta("uidA")) this.setMeta("uidA", uidA);
      if (uidB && !this.getMeta("uidB")) this.setMeta("uidB", uidB);
      return;
    }
    if (!this.voteSeedPromise) this.voteSeedPromise = this.doVoteSeed(matchId, uidA, uidB);
    await this.voteSeedPromise;
  }

  private async doVoteSeed(
    matchId: string | undefined,
    uidA: string | null,
    uidB: string | null,
  ): Promise<void> {
    if (!matchId) return;
    this.setMeta("matchId", matchId);
    if (uidA) this.setMeta("uidA", uidA);
    if (uidB) this.setMeta("uidB", uidB);

    try {
      const rows = await this.env.DB.prepare(
        "SELECT voter_uid, voted_for_uid, device_id, created_at FROM votes WHERE match_id = ?",
      )
        .bind(matchId)
        .all<{
          voter_uid: string;
          voted_for_uid: string;
          device_id: string | null;
          created_at: number;
        }>();

      for (const r of rows.results ?? []) {
        // Existing votes are already durable in D1 -> flushed = 1, xp_awarded = 1.
        this.sql.exec(
          "INSERT OR IGNORE INTO voters (voter_uid, voted_for_uid, device_id, created_at, flushed, xp_awarded) VALUES (?, ?, ?, ?, 1, 1)",
          r.voter_uid,
          r.voted_for_uid,
          r.device_id ?? null,
          r.created_at ?? Date.now(),
        );
        this.sql.exec(
          "INSERT INTO tallies (uid, votes) VALUES (?, 1) ON CONFLICT(uid) DO UPDATE SET votes = votes + 1",
          r.voted_for_uid,
        );
      }
    } catch (e) {
      console.error("[VoteCounter] vote seed failed", matchId, e);
      this.voteSeedPromise = null;
      // Do NOT proceed: voting against an unseeded (empty) baseline would bypass
      // the already-voted / device-used dedup guards. Fail so the caller retries.
      throw e;
    }
    this.setMeta("voteSeeded", "1");
  }

  private async ensureEngagementSeeded(matchId: string | undefined): Promise<void> {
    if (this.getMeta("engSeeded") === "1") return;
    if (!this.engSeedPromise) this.engSeedPromise = this.doEngagementSeed(matchId);
    await this.engSeedPromise;
  }

  private async doEngagementSeed(matchId: string | undefined): Promise<void> {
    if (!matchId) return;
    this.setMeta("matchId", matchId);
    try {
      const row = await this.env.DB.prepare(
        "SELECT like_count, comment_count, share_count, reactions FROM contest_matches WHERE id = ?",
      )
        .bind(matchId)
        .first<{
          like_count: number | null;
          comment_count: number | null;
          share_count: number | null;
          reactions: string | null;
        }>();

      if (row) {
        this.seedCounter("like", row.like_count);
        this.seedCounter("comment", row.comment_count);
        this.seedCounter("share", row.share_count);
        if (row.reactions) {
          try {
            const obj = JSON.parse(row.reactions) as Record<string, number>;
            for (const [k, v] of Object.entries(obj)) this.seedCounter(`react:${k}`, v);
          } catch {
            /* ignore malformed reactions json */
          }
        }
      }
    } catch (e) {
      console.error("[VoteCounter] engagement seed failed", matchId, e);
      this.engSeedPromise = null;
      // Bail: flushing absolute counters from an unseeded (zero) baseline would
      // clobber the real counts in D1. Fail so the caller retries.
      throw e;
    }
    this.setMeta("engSeeded", "1");
  }

  private seedCounter(name: string, value: number | null | undefined): void {
    const v = Math.max(Number(value) || 0, 0);
    this.sql.exec(
      "INSERT INTO counters (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value",
      name,
      v,
    );
  }

  // -------------------------------------------------------------------- flush
  private async scheduleFlush(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing == null) await this.ctx.storage.setAlarm(Date.now() + FLUSH_MS);
  }

  /** Alarm handler — batch-write accumulated state into D1. */
  async alarm(): Promise<void> {
    await this.flush();
  }

  private async flush(): Promise<void> {
    const matchId = this.getMeta("matchId");
    if (!matchId) return;

    const statements: D1PreparedStatement[] = [];

    // 1) Vote counters (absolute) — only if this match saw votes.
    if (this.getMeta("voteSeeded") === "1") {
      const { votesA, votesB, total } = this.voteTally();
      statements.push(
        this.env.DB.prepare(
          `UPDATE contest_matches
              SET user_a = CASE WHEN user_a IS NOT NULL THEN json_set(user_a, '$.votes', ?) ELSE user_a END,
                  user_b = CASE WHEN user_b IS NOT NULL THEN json_set(user_b, '$.votes', ?) ELSE user_b END,
                  total_votes = ?
            WHERE id = ?`,
        ).bind(votesA, votesB, total, matchId),
      );
    }

    // 2) Engagement counters (absolute) — only if this match saw engagement.
    if (this.getMeta("engSeeded") === "1") {
      const c = this.counterMap();
      const reactions: Record<string, number> = {};
      for (const [k, v] of Object.entries(c)) {
        if (k.startsWith("react:")) reactions[k.slice("react:".length)] = v;
      }
      statements.push(
        this.env.DB.prepare(
          `UPDATE contest_matches
              SET like_count = ?, comment_count = ?, share_count = ?, reactions = ?
            WHERE id = ?`,
        ).bind(c.like ?? 0, c.comment ?? 0, c.share ?? 0, JSON.stringify(reactions), matchId),
      );
    }

    // 3) Persist not-yet-flushed vote audit rows.
    const pending = this.sql
      .exec(
        "SELECT voter_uid, voted_for_uid, device_id, created_at FROM voters WHERE flushed = 0",
      )
      .toArray() as Array<{
      voter_uid: string;
      voted_for_uid: string;
      device_id: string | null;
      created_at: number;
    }>;
    if (pending.length > 0) {
      const insertVote = this.env.DB.prepare(
        "INSERT OR IGNORE INTO votes (id, match_id, voter_uid, voted_for_uid, device_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const r of pending) {
        statements.push(
          insertVote.bind(
            `${matchId}_${r.voter_uid}`,
            matchId,
            r.voter_uid,
            r.voted_for_uid,
            r.device_id ?? null,
            r.created_at,
          ),
        );
      }
    }

    // 4) Batched vote XP for voters who haven't been credited yet.
    const xpPending = (
      this.sql
        .exec("SELECT voter_uid FROM voters WHERE xp_awarded = 0")
        .toArray() as Array<{ voter_uid: string }>
    ).map((r) => r.voter_uid);
    const ts = Date.now();
    for (let i = 0; i < xpPending.length; i += XP_CHUNK) {
      const chunk = xpPending.slice(i, i + XP_CHUNK);
      const placeholders = chunk.map(() => "?").join(",");
      statements.push(
        this.env.DB.prepare(
          `UPDATE users SET xp = xp + ${VOTE_XP}, updated_at = ? WHERE uid IN (${placeholders})`,
        ).bind(ts, ...chunk),
      );
    }

    if (statements.length === 0) return;

    try {
      await this.env.DB.batch(statements);
      // Only mark local rows done AFTER D1 confirms the batch.
      if (pending.length > 0) this.sql.exec("UPDATE voters SET flushed = 1 WHERE flushed = 0");
      if (xpPending.length > 0) this.sql.exec("UPDATE voters SET xp_awarded = 1 WHERE xp_awarded = 0");
    } catch (e) {
      console.error("[VoteCounter] flush failed", matchId, e);
      // Leave rows unflushed and reschedule so the next window retries.
      await this.ctx.storage.setAlarm(Date.now() + FLUSH_MS);
    }
  }

  // -------------------------------------------------------------------- helpers
  private voteTally(): { votesA: number; votesB: number; total: number } {
    const uidA = this.getMeta("uidA");
    const uidB = this.getMeta("uidB");
    const votesA = uidA ? this.votesFor(uidA) : 0;
    const votesB = uidB ? this.votesFor(uidB) : 0;
    return { votesA, votesB, total: this.totalVotes() };
  }

  private votesFor(uid: string): number {
    const row = this.sql.exec("SELECT votes FROM tallies WHERE uid = ?", uid).toArray()[0] as
      | { votes: number }
      | undefined;
    return row ? Number(row.votes) : 0;
  }

  private totalVotes(): number {
    const row = this.sql
      .exec("SELECT COALESCE(SUM(votes), 0) AS t FROM tallies")
      .toArray()[0] as { t: number } | undefined;
    return row ? Number(row.t) : 0;
  }

  private counterMap(): Record<string, number> {
    const rows = this.sql.exec("SELECT name, value FROM counters").toArray() as Array<{
      name: string;
      value: number;
    }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.name] = Number(r.value);
    return out;
  }

  private getMeta(k: string): string | null {
    const row = this.sql.exec("SELECT v FROM meta WHERE k = ?", k).toArray()[0] as
      | { v: string }
      | undefined;
    return row ? row.v : null;
  }

  private setMeta(k: string, v: string): void {
    this.sql.exec(
      "INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
      k,
      v,
    );
  }
}
