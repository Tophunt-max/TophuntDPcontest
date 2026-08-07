/**
 * VoteCounter — a SQLite-backed Durable Object that owns the authoritative
 * vote tally for ONE contest match (addressed via idFromName(matchId)).
 *
 * Why this exists
 * ---------------
 * D1 has a single writer for the whole database. The old vote path did two D1
 * writes per vote — an INSERT into `votes` (dedup) and an UPDATE of the match
 * row's JSON counters (`user_a`/`user_b`.$.votes + total_votes). Under a viral
 * battle, thousands of concurrent voters hammer the SAME match row and contend
 * with every other write in the app (wallet, chat, ...). That is the classic
 * single-writer bottleneck.
 *
 * This DO removes D1 from the hot path:
 *   - Dedup + tally happen in the DO's own local SQLite (strongly consistent,
 *     serialized per match, microsecond-fast — no shared-writer contention).
 *   - An alarm batches the accumulated deltas back into D1 every FLUSH_MS, so
 *     N votes become ~1 D1 write per flush window instead of N writes.
 *
 * Correctness on migration / cold start
 * -------------------------------------
 * The first time the DO handles a match it SEEDS itself from D1's existing
 * `votes` rows (source of truth for who voted). So matches that already had
 * votes before this feature shipped keep their counts AND their dedup guard —
 * no double-voting, no lost tallies.
 *
 * The Worker verifies the Firebase token, match status and participant rules
 * BEFORE calling this DO, so — like RealtimeHub — the DO trusts its caller.
 */
import type { Env } from "./types";

/** How long votes accumulate in the DO before being batch-written to D1. */
const FLUSH_MS = 5_000;

interface VotePayload {
  matchId: string;
  voterUid: string;
  votedForUid: string;
  deviceId?: string | null;
  uidA?: string | null;
  uidB?: string | null;
}

interface TallyResult {
  alreadyVoted: boolean;
  votesA: number;
  votesB: number;
  total: number;
}

export class VoteCounter {
  private state: DurableObjectState;
  private env: Env;
  private sql: SqlStorage;
  private seedPromise: Promise<void> | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.sql = state.storage.sql;
    // Local (DO-owned) SQLite schema. Idempotent, cheap.
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);`,
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS voters (
         voter_uid    TEXT PRIMARY KEY,
         voted_for_uid TEXT NOT NULL,
         device_id    TEXT,
         created_at   INTEGER NOT NULL,
         flushed      INTEGER NOT NULL DEFAULT 0
       );`,
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS tallies (
         uid   TEXT PRIMARY KEY,
         votes INTEGER NOT NULL DEFAULT 0
       );`,
    );
  }

  // --------------------------------------------------------------------- HTTP
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = await request.json<VotePayload>().catch(() => ({}) as VotePayload);

    if (url.pathname === "/vote") {
      const result = await this.handleVote(body);
      return Response.json(result);
    }

    // Force a synchronous flush and return the authoritative tally. Used by the
    // cron resolver right before it decides a winner.
    if (url.pathname === "/flush") {
      await this.ensureSeeded(body.matchId, body.uidA ?? null, body.uidB ?? null);
      await this.flush();
      return Response.json(this.tally());
    }

    // Read-only current tally (seeds if needed). Handy for live reads.
    if (url.pathname === "/tally") {
      await this.ensureSeeded(body.matchId, body.uidA ?? null, body.uidB ?? null);
      return Response.json(this.tally());
    }

    return new Response("not found", { status: 404 });
  }

  // -------------------------------------------------------------------- voting
  private async handleVote(p: VotePayload): Promise<TallyResult> {
    await this.ensureSeeded(p.matchId, p.uidA ?? null, p.uidB ?? null);

    const existing = this.sql
      .exec("SELECT 1 FROM voters WHERE voter_uid = ? LIMIT 1", p.voterUid)
      .toArray();
    if (existing.length > 0) {
      return { alreadyVoted: true, ...this.tally() };
    }

    const ts = Date.now();
    this.sql.exec(
      "INSERT INTO voters (voter_uid, voted_for_uid, device_id, created_at, flushed) VALUES (?, ?, ?, ?, 0)",
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
    return { alreadyVoted: false, ...this.tally() };
  }

  // --------------------------------------------------------------------- seed
  /**
   * On first touch, load the match's participant uids and any pre-existing
   * votes from D1 so the DO's local tally is authoritative from the start.
   */
  private async ensureSeeded(
    matchId: string | undefined,
    uidA: string | null,
    uidB: string | null,
  ): Promise<void> {
    if (this.getMeta("seeded") === "1") {
      // Keep participant meta fresh if the caller supplied it and we lacked it.
      if (uidA && !this.getMeta("uidA")) this.setMeta("uidA", uidA);
      if (uidB && !this.getMeta("uidB")) this.setMeta("uidB", uidB);
      return;
    }
    if (!this.seedPromise) this.seedPromise = this.doSeed(matchId, uidA, uidB);
    await this.seedPromise;
  }

  private async doSeed(
    matchId: string | undefined,
    uidA: string | null,
    uidB: string | null,
  ): Promise<void> {
    if (!matchId) return; // cannot seed without a match id; leave un-seeded
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
        // Existing votes are already durable in D1 -> mark flushed = 1.
        this.sql.exec(
          "INSERT OR IGNORE INTO voters (voter_uid, voted_for_uid, device_id, created_at, flushed) VALUES (?, ?, ?, ?, 1)",
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
      console.error("[VoteCounter] seed failed", matchId, e);
      // Leave un-seeded so a later call can retry from a clean slate.
      this.seedPromise = null;
      return;
    }

    this.setMeta("seeded", "1");
  }

  // -------------------------------------------------------------------- flush
  private async scheduleFlush(): Promise<void> {
    const existing = await this.state.storage.getAlarm();
    if (existing == null) {
      await this.state.storage.setAlarm(Date.now() + FLUSH_MS);
    }
  }

  /** Alarm handler — batch-write accumulated votes into D1. */
  async alarm(): Promise<void> {
    await this.flush();
  }

  private async flush(): Promise<void> {
    const matchId = this.getMeta("matchId");
    if (!matchId) return;
    const uidA = this.getMeta("uidA");
    const uidB = this.getMeta("uidB");
    const { votesA, votesB, total } = this.tally();

    try {
      // 1) Authoritative counters written as ABSOLUTE values (idempotent).
      await this.env.DB.prepare(
        `UPDATE contest_matches
            SET user_a = CASE WHEN user_a IS NOT NULL
                              THEN json_set(user_a, '$.votes', ?) ELSE user_a END,
                user_b = CASE WHEN user_b IS NOT NULL
                              THEN json_set(user_b, '$.votes', ?) ELSE user_b END,
                total_votes = ?
          WHERE id = ?`,
      )
        .bind(votesA, votesB, total, matchId)
        .run();

      // 2) Persist any not-yet-flushed audit rows in one batch.
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
        const stmt = this.env.DB.prepare(
          "INSERT OR IGNORE INTO votes (id, match_id, voter_uid, voted_for_uid, device_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        );
        const batch = pending.map((r) =>
          stmt.bind(
            `${matchId}_${r.voter_uid}`,
            matchId,
            r.voter_uid,
            r.voted_for_uid,
            r.device_id ?? null,
            r.created_at,
          ),
        );
        await this.env.DB.batch(batch);
        this.sql.exec("UPDATE voters SET flushed = 1 WHERE flushed = 0");
      }
    } catch (e) {
      // Do NOT mark rows flushed — reschedule so the next window retries.
      console.error("[VoteCounter] flush failed", matchId, e);
      await this.state.storage.setAlarm(Date.now() + FLUSH_MS);
    }
  }

  // -------------------------------------------------------------------- helpers
  private tally(): { votesA: number; votesB: number; total: number } {
    const uidA = this.getMeta("uidA");
    const uidB = this.getMeta("uidB");
    const votesA = uidA ? this.votesFor(uidA) : 0;
    const votesB = uidB ? this.votesFor(uidB) : 0;
    const total = this.totalVotes();
    return { votesA, votesB, total };
  }

  private votesFor(uid: string): number {
    const row = this.sql
      .exec("SELECT votes FROM tallies WHERE uid = ?", uid)
      .toArray()[0] as { votes: number } | undefined;
    return row ? Number(row.votes) : 0;
  }

  private totalVotes(): number {
    const row = this.sql
      .exec("SELECT COALESCE(SUM(votes), 0) AS t FROM tallies")
      .toArray()[0] as { t: number } | undefined;
    return row ? Number(row.t) : 0;
  }

  private getMeta(k: string): string | null {
    const row = this.sql
      .exec("SELECT v FROM meta WHERE k = ?", k)
      .toArray()[0] as { v: string } | undefined;
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
