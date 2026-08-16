import type { Env } from "../types";

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
}

/** Atomically claim a match, pay its winner, update stats/XP, and write ledger. */
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

  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE contest_matches
          SET status = 'completed', winner_uid = ?, reward_amount = ?,
              completed_at = ?, settlement_id = ?
        WHERE id = ? AND status = ? AND settlement_id IS NULL
          AND EXISTS (SELECT 1 FROM users WHERE uid = ?)
          AND EXISTS (SELECT 1 FROM users WHERE uid = ?)`,
    ).bind(
      input.winnerUid,
      input.rewardAmount,
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
      input.rewardAmount,
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
      input.rewardAmount,
      input.contestId ?? null,
      input.matchId,
      input.description,
      input.completedAt,
      input.matchId,
      settlementId,
    ),
  ]);

  return Number(results[0]?.meta?.changes || 0) > 0;
}
