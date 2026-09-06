import type { Env } from "../types";
import type { ProductPrize } from "./prizes";

export type MatchStatus = "waiting_for_opponent" | "active";
export type FinalMatchStatus = "completed" | "cancelled";

interface RefundSettlement {
  matchId: string;
  contestId?: string | null;
  expectedStatus: MatchStatus;
  finalStatus: FinalMatchStatus;
  participantUids: string[];
  refundPerUser: number;
  description: string;
  completedAt: number;
}

/**
 * Atomically claim a match and refund its participants exactly once.
 *
 * Every financial statement is gated by the unique settlement token written by
 * the first UPDATE. If another resolver wins the race, its token differs and
 * every balance/ledger statement in this batch becomes a no-op.
 */
export async function settleRefund(
  env: Env,
  input: RefundSettlement,
): Promise<boolean> {
  const settlementId = crypto.randomUUID();
  const participantUids = [...new Set(input.participantUids)];
  const recipientPlaceholders = participantUids.map(() => "?").join(",");
  const recipientGate = participantUids.length > 0
    ? `AND (SELECT COUNT(*) FROM users WHERE uid IN (${recipientPlaceholders})) = ?`
    : "";
  const claimBindings: unknown[] = [
    input.finalStatus,
    input.completedAt,
    settlementId,
    input.matchId,
    input.expectedStatus,
  ];
  if (participantUids.length > 0) {
    claimBindings.push(...participantUids, participantUids.length);
  }
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE contest_matches
          SET status = ?, completed_at = ?, reward_amount = 0,
              winner_uid = NULL, settlement_id = ?
        WHERE id = ? AND status = ? AND settlement_id IS NULL
          ${recipientGate}`,
    ).bind(...claimBindings),
  ];

  if (input.refundPerUser > 0) {
    for (const uid of participantUids) {
      const transactionId = `contest_refund:${input.matchId}:${uid}`;
      statements.push(
        env.DB.prepare(
          `UPDATE users
              SET dpcoin = dpcoin + ?, updated_at = ?
            WHERE uid = ?
              AND EXISTS (
                SELECT 1 FROM contest_matches
                 WHERE id = ? AND settlement_id = ?
              )
              AND NOT EXISTS (
                SELECT 1 FROM coin_transactions WHERE id = ?
              )`,
        ).bind(
          input.refundPerUser,
          input.completedAt,
          uid,
          input.matchId,
          settlementId,
          transactionId,
        ),
      );
      statements.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO coin_transactions
             (id, uid, amount, type, contest_id, match_id, description, created_at)
           SELECT ?, ?, ?, 'contest_refund', ?, ?, ?, ?
            WHERE EXISTS (
              SELECT 1 FROM contest_matches
               WHERE id = ? AND settlement_id = ?
            )`,
        ).bind(
          transactionId,
          uid,
          input.refundPerUser,
          input.contestId ?? null,
          input.matchId,
          input.description,
          input.completedAt,
          input.matchId,
          settlementId,
        ),
      );
    }
  }

  const results = await env.DB.batch(statements);
  return Number(results[0]?.meta?.changes || 0) > 0;
}

interface WinnerSettlement {
  matchId: string;
  contestId?: string | null;
  expectedStatus: "active";
  winnerUid: string;
  loserUid: string;
  rewardAmount: number;
  description: string;
  completedAt: number;
  /**
   * Set when this contest awards a PHYSICAL product instead of coins.
   *
   * `rewardAmount` must be 0 in that case — a product prize credits no wallet, and
   * the caller resolves which kind applies through `resolveMatchPrize` (lib/prizes.ts).
   */
  productPrize?: ProductPrize | null;
}

/**
 * Atomically claim a match, pay its winner, update stats/XP, and write ledger.
 *
 * When `productPrize` is present the coin statements still run — with an amount of
 * 0, so they move no balance — and one extra statement appends the `prize_claims`
 * row that records the debt. Three properties of that arrangement are the reason
 * it is written this way rather than as a follow-up insert after settlement:
 *
 *   - It is in the SAME `DB.batch`, which is one implicit transaction, so a match
 *     can never be marked completed without the claim that says what is owed.
 *   - It carries the SAME `gate` as every other statement, so a resolver that lost
 *     the claim race writes nothing — otherwise two concurrent resolvers would both
 *     create a delivery obligation for one battle.
 *   - Its id is deterministic (`prize_claim:<matchId>`) and it is an
 *     `INSERT OR IGNORE`, so even a replayed token cannot duplicate it. That mirrors
 *     how `contest_win:<matchId>` protects the coin ledger.
 *
 * The XP/wins/loser statements keep their existing gate on the coin ledger row's
 * absence. For a product prize that row is still written (amount 0), so it remains
 * the marker that this match's stats have already been applied.
 */
export async function settleWinner(
  env: Env,
  input: WinnerSettlement,
): Promise<boolean> {
  const settlementId = crypto.randomUUID();
  const transactionId = `contest_win:${input.matchId}`;
  const gate = `EXISTS (
    SELECT 1 FROM contest_matches
     WHERE id = ? AND settlement_id = ?
  )`;
  const product = input.productPrize ?? null;
  // Defensive: a product prize must never also move coins. The callers already
  // guarantee this via resolveMatchPrize, but this function is the last place the
  // amount is used and the cheapest place to be certain.
  const rewardAmount = product ? 0 : input.rewardAmount;

  const statements = [
    env.DB.prepare(
      `UPDATE contest_matches
          SET status = 'completed', winner_uid = ?, reward_amount = ?,
              completed_at = ?, settlement_id = ?
        WHERE id = ? AND status = ? AND settlement_id IS NULL
          AND EXISTS (SELECT 1 FROM users WHERE uid = ?)
          AND EXISTS (SELECT 1 FROM users WHERE uid = ?)`,
    ).bind(
      input.winnerUid,
      rewardAmount,
      input.completedAt,
      settlementId,
      input.matchId,
      input.expectedStatus,
      input.winnerUid,
      input.loserUid,
    ),
    env.DB.prepare(
      `UPDATE users
          SET dpcoin = dpcoin + ?, xp = xp + 100,
              wins = wins + 1, monthly_wins = monthly_wins + 1,
              updated_at = ?
        WHERE uid = ? AND ${gate}
          AND NOT EXISTS (SELECT 1 FROM coin_transactions WHERE id = ?)`,
    ).bind(
      rewardAmount,
      input.completedAt,
      input.winnerUid,
      input.matchId,
      settlementId,
      transactionId,
    ),
    env.DB.prepare(
      `UPDATE users
          SET xp = xp + 20, updated_at = ?
        WHERE uid = ? AND ${gate}
          AND NOT EXISTS (SELECT 1 FROM coin_transactions WHERE id = ?)`,
    ).bind(
      input.completedAt,
      input.loserUid,
      input.matchId,
      settlementId,
      transactionId,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO coin_transactions
         (id, uid, amount, type, contest_id, match_id, description, created_at)
       SELECT ?, ?, ?, 'contest_win_reward', ?, ?, ?, ?
        WHERE ${gate}`,
    ).bind(
      transactionId,
      input.winnerUid,
      rewardAmount,
      input.contestId ?? null,
      input.matchId,
      input.description,
      input.completedAt,
      input.matchId,
      settlementId,
    ),
  ];

  if (product) {
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO prize_claims
           (id, match_id, contest_id, uid, status,
            product_title, product_image_url, product_value,
            created_at, updated_at)
         SELECT ?, ?, ?, ?, 'unclaimed', ?, ?, ?, ?, ?
          WHERE ${gate}`,
      ).bind(
        `prize_claim:${input.matchId}`,
        input.matchId,
        input.contestId ?? null,
        input.winnerUid,
        product.title,
        product.imageUrl,
        product.value,
        input.completedAt,
        input.completedAt,
        input.matchId,
        settlementId,
      ),
    );
  }

  const results = await env.DB.batch(statements);

  return Number(results[0]?.meta?.changes || 0) > 0;
}
