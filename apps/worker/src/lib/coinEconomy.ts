/**
 * Coin economy reports for the admin panel — where every coin came from and
 * where it went.
 *
 * Three books are read together:
 *
 *   users.dpcoin / locked_coins   what users hold now (withdrawable + play-only)
 *   coin_transactions             every movement of a user's balance
 *   platform_ledger               the platform's own side: promo coins it paid
 *                                 (negative) and entry fees it kept (positive)
 *
 * and checked against each other (`checks`), so a drift shows up here before it
 * shows up in a payout.
 *
 * Read-only. Every query is independent and degrades to an empty/zero value on
 * failure instead of failing the whole report.
 */
import type { Env } from "../types";
import { coinValueFromConfig } from "./coinPricing";
import { getAppConfig } from "./settings";

/** How each ledger type is grouped in the report. Unknown types land in "other". */
export const LEDGER_CATEGORIES: Record<string, string> = {
  purchase: "paid_in",
  manual_deposit: "paid_in",
  promo_bonus: "promo",
  signup_bonus: "rewards",
  referral_bonus: "rewards",
  verification_bonus: "rewards",
  daily_reward: "rewards",
  ad_reward: "rewards",
  daily_task: "rewards",
  monthly_hall_of_fame_reward: "rewards",
  admin_adjustment: "admin",
  contest_entry_fee: "contests",
  contest_win_reward: "contests",
  contest_refund: "contests",
  contest_entry_refund: "contests",
  withdrawal_hold: "cash_out",
  withdrawal_refund: "cash_out",
  withdrawal_hold_release: "cash_out",
  withdrawal: "cash_out",
  refund_clawback: "reversals",
  chargeback_clawback: "reversals",
  account_deletion_forfeit: "reversals",
  balance_rounding: "reversals",
};

export const CATEGORY_LABELS: Record<string, string> = {
  paid_in: "Paise se khareede gaye coin",
  promo: "Promo bonus (budget se, locked)",
  rewards: "Free rewards (signup, referral, daily, ads, tasks)",
  admin: "Admin adjustments",
  contests: "Contests (entry fee − prize − refund)",
  cash_out: "Withdrawals",
  reversals: "Refund clawback / account deletion",
  other: "Other",
};

async function all<T>(env: Env, sql: string, ...binds: unknown[]): Promise<T[]> {
  try {
    const res = await env.DB.prepare(sql).bind(...binds).all<T>();
    return (res.results ?? []) as T[];
  } catch (e) {
    console.error("[coinEconomy] query failed", sql, e);
    return [];
  }
}

async function one<T>(env: Env, sql: string, ...binds: unknown[]): Promise<T | null> {
  try {
    return (await env.DB.prepare(sql).bind(...binds).first<T>()) ?? null;
  } catch (e) {
    console.error("[coinEconomy] query failed", sql, e);
    return null;
  }
}

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export interface LedgerTypeRow {
  type: string;
  category: string;
  credits: number;
  debits: number;
  net: number;
  count: number;
}

/** Optional [from, to) window in ms for the flow figures. Supply/checks are always all-time. */
export interface Range {
  from?: number | null;
  to?: number | null;
}

function rangeSql(col: string, r: Range): { sql: string; binds: number[] } {
  const parts: string[] = [];
  const binds: number[] = [];
  if (r.from) { parts.push(`${col} >= ?`); binds.push(r.from); }
  if (r.to) { parts.push(`${col} < ?`); binds.push(r.to); }
  return { sql: parts.length ? `WHERE ${parts.join(" AND ")}` : "", binds };
}

export async function coinEconomyOverview(env: Env, range: Range = {}) {
  const cfg = await getAppConfig(env);
  const payoutRate = coinValueFromConfig(cfg) ?? 0;
  const txRange = rangeSql("created_at", range);

  const [supply, byType, platform, cash, ledgerAll, lockedLedger, lockedOver, lockedNeg, staleRes, overspent, budgets] =
    await Promise.all([
      one<any>(env, `SELECT COALESCE(SUM(dpcoin),0) AS total, COALESCE(SUM(locked_coins),0) AS locked,
                            SUM(CASE WHEN dpcoin > 0 THEN 1 ELSE 0 END) AS holders FROM users`),
      all<any>(env, `SELECT type,
                            COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END),0) AS credits,
                            COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END),0) AS debits,
                            COALESCE(SUM(amount),0) AS net, COUNT(*) AS n
                       FROM coin_transactions ${txRange.sql} GROUP BY type`, ...txRange.binds),
      all<any>(env, `SELECT kind, COALESCE(SUM(coins),0) AS coins, COUNT(*) AS n
                       FROM platform_ledger ${txRange.sql} GROUP BY kind`, ...txRange.binds),
      one<any>(env, `SELECT
          (SELECT COALESCE(SUM(amount_paise),0) FROM payments WHERE status IN ('success','partially_refunded')) AS paid_in_paise,
          (SELECT COALESCE(SUM(refunded_amount_paise),0) FROM payment_orders WHERE refunded_amount_paise > 0) AS refunded_paise,
          (SELECT COALESCE(SUM(cash_amount),0) FROM withdrawals WHERE status = 'paid') AS paid_out_inr,
          (SELECT COALESCE(SUM(cash_amount),0) FROM withdrawals WHERE status IN ('pending','approved')) AS pending_out_inr`),
      one<any>(env, `SELECT COALESCE(SUM(amount),0) AS n FROM coin_transactions`),
      one<any>(env, `SELECT COALESCE(SUM(locked_delta),0) AS n FROM coin_transactions`),
      one<any>(env, `SELECT COUNT(*) AS n FROM users WHERE locked_coins > MAX(dpcoin, 0) + 0.5`),
      one<any>(env, `SELECT COUNT(*) AS n FROM users WHERE locked_coins < 0`),
      one<any>(env, `SELECT COUNT(*) AS n FROM promo_reservations r
                      WHERE r.status = 'held' AND (
                        (r.ref_type = 'match' AND NOT EXISTS (SELECT 1 FROM contest_matches m
                            WHERE m.id = r.ref_id AND m.status IN ('waiting_for_opponent','active')))
                        OR (r.ref_type = 'deposit' AND NOT EXISTS (SELECT 1 FROM deposits d
                            WHERE d.id = r.ref_id AND d.status = 'pending')))`),
      one<any>(env, `SELECT COUNT(*) AS n FROM promo_budgets WHERE spent_coins > total_coins`),
      one<any>(env, `SELECT COALESCE(SUM(total_coins),0) AS total, COALESCE(SUM(spent_coins),0) AS spent,
                            SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active, COUNT(*) AS n
                       FROM promo_budgets`),
    ]);

  const types: LedgerTypeRow[] = byType
    .map((r) => ({
      type: String(r.type),
      category: LEDGER_CATEGORIES[r.type] ?? "other",
      credits: num(r.credits),
      debits: num(r.debits),
      net: num(r.net),
      count: num(r.n),
    }))
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net));

  const categories: Record<string, { label: string; credits: number; debits: number; net: number }> = {};
  for (const t of types) {
    const c = (categories[t.category] ??= { label: CATEGORY_LABELS[t.category] ?? t.category, credits: 0, debits: 0, net: 0 });
    c.credits += t.credits;
    c.debits += t.debits;
    c.net += t.net;
  }

  const platformKinds: Record<string, { coins: number; count: number }> = {};
  for (const p of platform) platformKinds[p.kind] = { coins: num(p.coins), count: num(p.n) };
  const platformNet = Object.values(platformKinds).reduce((s, k) => s + k.coins, 0);

  const total = num(supply?.total);
  const locked = num(supply?.locked);
  const withdrawable = Math.max(0, total - locked);
  const ledgerTotal = num(ledgerAll?.n);
  const lockedLedgerTotal = num(lockedLedger?.n);

  const checks = [
    {
      key: "supply_vs_ledger",
      label: "Users ke coin = ledger ka total",
      ok: Math.abs(total - ledgerTotal) < 0.5,
      detail: `Users: ${total}, ledger: ${ledgerTotal}`,
    },
    {
      key: "locked_vs_ledger",
      label: "Locked coin = ledger ka locked total",
      ok: Math.abs(locked - lockedLedgerTotal) < 0.5,
      detail: `Users: ${locked}, ledger: ${lockedLedgerTotal}`,
    },
    {
      key: "locked_le_balance",
      label: "Kisi ke locked coin uske balance se zyada nahi",
      ok: num(lockedOver?.n) === 0 && num(lockedNeg?.n) === 0,
      detail: `${num(lockedOver?.n)} account(s) over, ${num(lockedNeg?.n)} negative`,
    },
    {
      key: "stale_reservations",
      label: "Koi atka hua budget reservation nahi",
      ok: num(staleRes?.n) === 0,
      detail: `${num(staleRes?.n)} reservation(s) held for a finished match / processed deposit`,
    },
    {
      key: "budgets_within_limit",
      label: "Koi budget apni limit se zyada kharch nahi hua",
      ok: num(overspent?.n) === 0,
      detail: `${num(overspent?.n)} budget(s) over their total`,
    },
  ];

  return {
    ts: Date.now(),
    range: { from: range.from ?? null, to: range.to ?? null },
    payoutRate,
    supply: {
      total,
      withdrawable,
      locked,
      holders: num(supply?.holders),
      // What the platform would owe if every withdrawable coin were cashed out now.
      liabilityInr: Math.round(withdrawable * payoutRate * 100) / 100,
    },
    cash: {
      paidInInr: num(cash?.paid_in_paise) / 100,
      refundedInr: num(cash?.refunded_paise) / 100,
      paidOutInr: num(cash?.paid_out_inr),
      pendingOutInr: num(cash?.pending_out_inr),
    },
    categories,
    types,
    platform: { kinds: platformKinds, net: platformNet },
    budgets: {
      total: num(budgets?.total),
      spent: num(budgets?.spent),
      active: num(budgets?.active),
      count: num(budgets?.n),
    },
    checks,
    ok: checks.every((c) => c.ok),
  };
}

/** Per contest: entry fees in, prizes and refunds out, subsidy paid and fees kept. */
export async function contestPnl(env: Env, limit = 200) {
  const rows = await all<any>(
    env,
    `SELECT c.id, c.title, c.status, c.total_entry_fee AS fee, c.reward_coins AS reward,
            c.prize_type AS prize_type, c.subsidy_budget_id AS budget_id,
            (SELECT COUNT(*) FROM contest_matches m WHERE m.contest_id = c.id) AS matches,
            (SELECT COUNT(*) FROM contest_matches m WHERE m.contest_id = c.id AND m.winner_uid IS NOT NULL) AS won,
            (SELECT COUNT(*) FROM contest_matches m WHERE m.contest_id = c.id AND m.status IN ('waiting_for_opponent','active')) AS live,
            COALESCE((SELECT -SUM(amount) FROM coin_transactions t WHERE t.contest_id = c.id AND t.type = 'contest_entry_fee'), 0) AS fees_in,
            COALESCE((SELECT SUM(amount) FROM coin_transactions t WHERE t.contest_id = c.id AND t.type IN ('contest_refund','contest_entry_refund')), 0) AS refunds,
            COALESCE((SELECT SUM(amount) FROM coin_transactions t WHERE t.contest_id = c.id AND t.type = 'contest_win_reward'), 0) AS prizes,
            COALESCE((SELECT -SUM(coins) FROM platform_ledger p WHERE p.contest_id = c.id AND p.kind = 'prize_subsidy'), 0) AS subsidy,
            COALESCE((SELECT SUM(coins) FROM platform_ledger p WHERE p.contest_id = c.id AND p.kind IN ('platform_fee','product_prize_fund')), 0) AS kept,
            COALESCE((SELECT SUM(coins) FROM promo_reservations r
                       WHERE r.ref_type = 'match' AND r.status = 'held'
                         AND r.ref_id IN (SELECT id FROM contest_matches m WHERE m.contest_id = c.id)), 0) AS subsidy_held
       FROM contests c
      ORDER BY c.created_at DESC
      LIMIT ?`,
    limit,
  );
  return rows.map((r) => {
    const feesIn = num(r.fees_in);
    const refunds = num(r.refunds);
    const prizes = num(r.prizes);
    return {
      id: r.id,
      title: r.title,
      status: r.status,
      totalEntryFee: num(r.fee),
      rewardCoins: num(r.reward),
      prizeType: r.prize_type ?? "coins",
      subsidyBudgetId: r.budget_id ?? null,
      matches: num(r.matches),
      won: num(r.won),
      live: num(r.live),
      feesIn,
      refunds,
      prizes,
      subsidy: num(r.subsidy),
      subsidyHeld: num(r.subsidy_held),
      platformKept: num(r.kept),
      // Coins this contest took out of (+) or put into (−) the users' side.
      net: feesIn - refunds - prizes,
    };
  });
}

/** Per package: purchases, rupees in, paid coins and bonus coins handed out. */
export async function packagePnl(env: Env) {
  const [pkgs, orders, deposits] = await Promise.all([
    all<any>(env, `SELECT id, name, coins, bonus_coins, active, budget_id FROM coin_packages ORDER BY sort_order`),
    all<any>(env, `SELECT package_id AS id, COUNT(*) AS n, COALESCE(SUM(amount_paise),0) AS paise,
                          COALESCE(SUM(coins - COALESCE(bonus_coins,0)),0) AS base,
                          COALESCE(SUM(COALESCE(bonus_coins,0)),0) AS bonus,
                          COALESCE(SUM(CASE WHEN budget_id IS NOT NULL THEN COALESCE(bonus_coins,0) ELSE 0 END),0) AS promo,
                          COALESCE(SUM(COALESCE(refunded_amount_paise,0)),0) AS refunded
                     FROM payment_orders
                    WHERE status IN ('paid','partially_refunded','refunded','disputed')
                    GROUP BY package_id`),
    all<any>(env, `SELECT package_id AS id, COUNT(*) AS n, COALESCE(SUM(pay_amount),0) AS inr,
                          COALESCE(SUM(amount - COALESCE(bonus_coins,0)),0) AS base,
                          COALESCE(SUM(COALESCE(bonus_coins,0)),0) AS bonus,
                          COALESCE(SUM(CASE WHEN budget_id IS NOT NULL THEN COALESCE(bonus_coins,0) ELSE 0 END),0) AS promo
                     FROM deposits WHERE status = 'approved' GROUP BY package_id`),
  ]);
  const o = new Map(orders.map((r) => [r.id, r]));
  const d = new Map(deposits.map((r) => [r.id, r]));
  const ids = new Set<string>([...pkgs.map((p) => p.id), ...o.keys(), ...d.keys()].filter(Boolean));
  const byId = new Map(pkgs.map((p) => [p.id, p]));
  return [...ids].map((id) => {
    const p = byId.get(id);
    const ro = o.get(id);
    const rd = d.get(id);
    return {
      id,
      name: p?.name ?? (p ? null : "(deleted package)"),
      active: p ? !!p.active : false,
      coins: num(p?.coins),
      bonusCoins: num(p?.bonus_coins),
      budgetId: p?.budget_id ?? null,
      purchases: num(ro?.n) + num(rd?.n),
      inr: num(ro?.paise) / 100 + num(rd?.inr),
      refundedInr: num(ro?.refunded) / 100,
      baseCoins: num(ro?.base) + num(rd?.base),
      bonusCoinsGiven: num(ro?.bonus) + num(rd?.bonus),
      promoBonusGiven: num(ro?.promo) + num(rd?.promo),
    };
  });
}

/** One user's statement: balances now, and ledger rows newest first with the balance after each. */
export async function userStatement(env: Env, uid: string, limit = 300) {
  const user = await one<any>(
    env,
    `SELECT uid, username, full_name, email, dpcoin, locked_coins FROM users WHERE uid = ? OR lower(username) = lower(?) LIMIT 1`,
    uid,
    uid,
  );
  if (!user) return null;
  const rows = await all<any>(
    env,
    `SELECT id, amount, type, contest_id, match_id, description, created_at, locked_delta, budget_id
       FROM coin_transactions WHERE uid = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
    user.uid,
    limit + 1,
  );
  const truncated = rows.length > limit;
  const page = truncated ? rows.slice(0, limit) : rows;
  const totals = await one<any>(
    env,
    `SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS sum, COALESCE(SUM(locked_delta),0) AS locked FROM coin_transactions WHERE uid = ?`,
    user.uid,
  );
  let balance = num(user.dpcoin);
  let locked = num(user.locked_coins);
  const entries = page.map((r) => {
    const e = {
      id: r.id,
      type: r.type,
      category: LEDGER_CATEGORIES[r.type] ?? "other",
      amount: num(r.amount),
      lockedDelta: num(r.locked_delta),
      contestId: r.contest_id ?? null,
      matchId: r.match_id ?? null,
      budgetId: r.budget_id ?? null,
      description: r.description ?? null,
      createdAt: r.created_at,
      balanceAfter: balance,
      lockedAfter: locked,
    };
    balance -= e.amount;
    locked -= e.lockedDelta;
    return e;
  });
  return {
    user: {
      uid: user.uid,
      username: user.username ?? null,
      fullName: user.full_name ?? null,
      email: user.email ?? null,
      balance: num(user.dpcoin),
      locked: num(user.locked_coins),
      withdrawable: Math.max(0, num(user.dpcoin) - num(user.locked_coins)),
    },
    ledger: {
      count: num(totals?.n),
      sum: num(totals?.sum),
      lockedSum: num(totals?.locked),
      balanced: Math.abs(num(totals?.sum) - num(user.dpcoin)) < 0.5 && Math.abs(num(totals?.locked) - num(user.locked_coins)) < 0.5,
    },
    entries,
    truncated,
  };
}

/** Budget detail: reservations and platform-ledger rows for one budget. */
export async function budgetActivity(env: Env, budgetId: string, limit = 200) {
  const [reservations, platform] = await Promise.all([
    all<any>(env, `SELECT id, uid, coins, status, ref_type, ref_id, expires_at, created_at, updated_at
                     FROM promo_reservations WHERE budget_id = ? ORDER BY created_at DESC LIMIT ?`, budgetId, limit),
    all<any>(env, `SELECT id, kind, coins, contest_id, match_id, uid, ref_id, description, created_at
                     FROM platform_ledger WHERE budget_id = ? ORDER BY created_at DESC LIMIT ?`, budgetId, limit),
  ]);
  return {
    reservations: reservations.map((r) => ({
      id: r.id, uid: r.uid ?? null, coins: num(r.coins), status: r.status, refType: r.ref_type, refId: r.ref_id,
      expiresAt: r.expires_at ?? null, createdAt: r.created_at, updatedAt: r.updated_at,
    })),
    payouts: platform.map((r) => ({
      id: r.id, kind: r.kind, coins: num(r.coins), contestId: r.contest_id ?? null, matchId: r.match_id ?? null,
      uid: r.uid ?? null, refId: r.ref_id ?? null, description: r.description ?? null, createdAt: r.created_at,
    })),
  };
}
