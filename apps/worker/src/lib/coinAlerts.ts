/**
 * Coin alerts and the coin report email.
 *
 * runCoinAlerts (every 6 hours, index.ts) raises one admin notification (and an
 * email to `adminAlertEmail`) when:
 *   - a promo budget is 80%+ used (spent + reserved)
 *   - the ₹ the platform owes (withdrawable coins × payout rate, plus payouts
 *     pending) is more than the ₹ it has taken in, net of refunds and payouts
 *   - a user received more free coins in 24 hours than
 *     `appConfig.coinAlerts.dailyFreeCoinsPerUser` (default 300)
 *
 * maybeSendCoinReport (hourly tick) emails a daily summary at ~03:00 UTC
 * (08:30 IST), and a weekly one on Mondays, to `adminAlertEmail`, unless
 * `appConfig.coinReport.enabled === false`. A settings row remembers what was
 * sent so a retried tick never sends twice.
 */
import type { Env } from "../types";
import { adminAlert, listBudgets } from "./promoBudget";
import { CATEGORY_LABELS, coinEconomyOverview } from "./coinEconomy";
import { getAppConfig } from "./settings";
import { sendEmail } from "./email";

const DAY = 24 * 60 * 60 * 1000;
const FREE_TYPES = ["verification_bonus", "referral_bonus", "daily_reward", "ad_reward", "daily_task"];
const DEFAULT_FREE_COINS_ALERT = 300;

export function freeCoinsAlertThreshold(cfg: any): number {
  const n = Number(cfg?.coinAlerts?.dailyFreeCoinsPerUser);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_FREE_COINS_ALERT;
}

/** Validate an App Control `coinAlerts` / `coinReport` patch in place. */
export function validateCoinAlertPatch(body: any): void {
  if (body?.coinAlerts !== undefined) {
    const a = body.coinAlerts;
    if (!a || typeof a !== "object") throw new Error("coinAlerts must be an object.");
    if (a.dailyFreeCoinsPerUser !== undefined) {
      const n = Number(a.dailyFreeCoinsPerUser);
      if (!Number.isInteger(n) || n < 1 || n > 10_000_000) throw new Error("coinAlerts.dailyFreeCoinsPerUser must be a whole number of coins (1 or more).");
      a.dailyFreeCoinsPerUser = n;
    }
  }
  if (body?.coinReport !== undefined) {
    const r = body.coinReport;
    if (!r || typeof r !== "object") throw new Error("coinReport must be an object.");
    for (const k of ["enabled", "daily", "weekly"]) {
      if (r[k] !== undefined && typeof r[k] !== "boolean") throw new Error(`coinReport.${k} must be true or false.`);
    }
  }
}

export interface CoinAlertResult {
  budgets: number;
  liability: boolean;
  heavyEarners: number;
}

export async function runCoinAlerts(env: Env, ts = Date.now()): Promise<CoinAlertResult> {
  const out: CoinAlertResult = { budgets: 0, liability: false, heavyEarners: 0 };
  const cfg = await getAppConfig(env);

  // 1. Budgets 80%+ used.
  for (const b of await listBudgets(env, ts)) {
    if (b.status !== "active" || b.totalCoins <= 0) continue;
    const used = (b.spentCoins + b.heldCoins) / b.totalCoins;
    if (used < 0.8) continue;
    const pct = Math.min(100, Math.round(used * 100));
    const sent = await adminAlert(
      env,
      `Budget ${pct >= 100 ? "khatam" : "80%+"}: ${b.name}`,
      `"${b.name}" ka ${pct}% use ho gaya (${b.spentCoins + b.heldCoins} / ${b.totalCoins} coin). Bache: ${b.remainingCoins}. Zaroorat ho to Coin Economy → Budgets me total badhao.`,
      "/coin-economy",
      3 * DAY,
    );
    if (sent) out.budgets++;
  }

  // 2. Liability vs cash.
  const eco = await coinEconomyOverview(env);
  const cash = eco.cash.paidInInr - eco.cash.refundedInr - eco.cash.paidOutInr;
  const owed = eco.supply.liabilityInr + eco.cash.pendingOutInr;
  if (owed > 0 && owed > cash) {
    out.liability = await adminAlert(
      env,
      "Liability cash se zyada",
      `Users ke withdraw hone wale coin + pending payout = ₹${owed.toFixed(2)}, jabki net cash (aaya − refund − bheja) = ₹${cash.toFixed(2)}. ` +
        `Free rewards ya promo budgets check karo.`,
      "/coin-economy",
      DAY,
    );
  }

  // 3. Users who got a lot of free coins in 24 hours.
  const threshold = freeCoinsAlertThreshold(cfg);
  const placeholders = FREE_TYPES.map(() => "?").join(",");
  const heavy = await env.DB.prepare(
    `SELECT t.uid AS uid, u.username AS username, SUM(t.amount) AS coins
       FROM coin_transactions t LEFT JOIN users u ON u.uid = t.uid
      WHERE t.created_at >= ? AND t.amount > 0 AND t.type IN (${placeholders})
        AND COALESCE(u.role, '') <> 'superadmin'
      GROUP BY t.uid HAVING SUM(t.amount) > ?
      ORDER BY coins DESC LIMIT 10`,
  )
    .bind(ts - DAY, ...FREE_TYPES, threshold)
    .all<{ uid: string; username: string | null; coins: number }>()
    .catch(() => ({ results: [] as any[] }));
  const rows = heavy.results ?? [];
  if (rows.length) {
    out.heavyEarners = rows.length;
    await adminAlert(
      env,
      "Zyada free coin kamane wale users",
      `${rows.length} user(s) ne 24 ghante me ${threshold}+ free coin liye: ` +
        rows.slice(0, 5).map((r) => `@${r.username ?? r.uid} (${r.coins})`).join(", ") +
        `. Coin Economy → Ledger me user statement dekho.`,
      "/coin-economy",
      DAY,
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Report email
// ---------------------------------------------------------------------------

const STATE_ID = "coinReportState";

async function readState(env: Env): Promise<{ daily?: string; weekly?: string }> {
  const row = await env.DB.prepare(`SELECT data FROM settings WHERE id = ?`).bind(STATE_ID).first<{ data: string }>().catch(() => null);
  try {
    return row?.data ? JSON.parse(row.data) : {};
  } catch {
    return {};
  }
}

async function writeState(env: Env, state: { daily?: string; weekly?: string }): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings (id, data, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
  ).bind(STATE_ID, JSON.stringify(state), Date.now()).run();
}

const esc = (x: unknown) => String(x ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] as string);
const n = (v: number) => Math.round(v).toLocaleString("en-IN");

/** The report body for the window [from, to). Exported for the admin "send now" button and tests. */
export async function buildCoinReport(env: Env, from: number, to: number, title: string): Promise<{ subject: string; html: string }> {
  const [eco, budgets] = await Promise.all([coinEconomyOverview(env, { from, to }), listBudgets(env, to)]);
  const cats = Object.entries(eco.categories).sort((a, b) => Math.abs(b[1].net) - Math.abs(a[1].net));
  const top = await env.DB.prepare(
    `SELECT t.uid AS uid, u.username AS username, SUM(t.amount) AS coins
       FROM coin_transactions t LEFT JOIN users u ON u.uid = t.uid
      WHERE t.created_at >= ? AND t.created_at < ? AND t.amount > 0
        AND t.type NOT IN ('opening', 'withdrawal_refund', 'withdrawal_hold_release', 'contest_refund', 'contest_entry_refund')
      GROUP BY t.uid ORDER BY coins DESC LIMIT 5`,
  ).bind(from, to).all<any>().catch(() => ({ results: [] as any[] }));
  const failing = eco.checks.filter((c) => !c.ok);
  const row = (k: string, v: string) => `<tr><td style="padding:4px 12px 4px 0;color:#555">${esc(k)}</td><td style="padding:4px 0;text-align:right"><b>${esc(v)}</b></td></tr>`;
  const html = `
  <div style="font-family:Arial,sans-serif;font-size:14px;color:#111">
    <h2 style="margin:0 0 4px">${esc(title)}</h2>
    <p style="margin:0 0 16px;color:#666">${esc(new Date(from).toISOString().slice(0, 16))} → ${esc(new Date(to).toISOString().slice(0, 16))} UTC</p>
    <h3>Abhi ki halat</h3>
    <table>${row("Users ke paas coin", n(eco.supply.total))}${row("Withdraw ho sakte hain", n(eco.supply.withdrawable))}${row("Locked (sirf khelne ke liye)", n(eco.supply.locked))}${row("Liability", `₹${eco.supply.liabilityInr.toFixed(2)}`)}${row("Payout pending", `₹${eco.cash.pendingOutInr.toFixed(2)}`)}</table>
    <h3>Is dauran coin flow</h3>
    <table>${cats.map(([k, c]) => row(CATEGORY_LABELS[k] ?? c.label, `${c.net > 0 ? "+" : ""}${n(c.net)}`)).join("")}</table>
    <h3>Platform</h3>
    <table>${Object.entries(eco.platform.kinds).map(([k, v]) => row(k, `${v.coins > 0 ? "+" : ""}${n(v.coins)}`)).join("") || row("—", "0")}</table>
    <h3>Budgets</h3>
    <table>${budgets.filter((b) => b.status !== "closed").map((b) => row(b.name, `${n(b.spentCoins)} / ${n(b.totalCoins)} (bache ${n(b.remainingCoins)})`)).join("") || row("Koi budget nahi", "")}</table>
    <h3>Sabse zyada coin paane wale</h3>
    <table>${(top.results ?? []).map((r: any) => row(`@${r.username ?? r.uid}`, n(r.coins))).join("") || row("—", "")}</table>
    <h3>Checks</h3>
    <p>${failing.length ? failing.map((c) => `⚠️ ${esc(c.label)}: ${esc(c.detail)}`).join("<br>") : "✅ Saare checks theek"}</p>
    <p style="color:#888">Admin panel → Coin Economy</p>
  </div>`;
  return { subject: `[TopHunt] ${title}${failing.length ? " ⚠️" : ""}`, html };
}

/** Hourly: send the daily report at 03:00 UTC, and the weekly on Monday. */
export async function maybeSendCoinReport(env: Env, ts = Date.now()): Promise<{ daily: boolean; weekly: boolean }> {
  const result = { daily: false, weekly: false };
  const cfg = await getAppConfig(env);
  const to = String(cfg?.adminAlertEmail || "");
  const settings = cfg?.coinReport || {};
  if (!to || settings.enabled === false) return result;
  const d = new Date(ts);
  if (d.getUTCHours() !== 3) return result;
  const today = d.toISOString().slice(0, 10);
  const state = await readState(env);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (settings.daily !== false && state.daily !== today) {
    const r = await buildCoinReport(env, start - DAY, start, `Daily coin report ${new Date(start - DAY).toISOString().slice(0, 10)}`);
    result.daily = await sendEmail(env, { to, ...r });
    if (result.daily) state.daily = today;
  }
  if (settings.weekly !== false && d.getUTCDay() === 1 && state.weekly !== today) {
    const r = await buildCoinReport(env, start - 7 * DAY, start, "Weekly coin report");
    result.weekly = await sendEmail(env, { to, ...r });
    if (result.weekly) state.weekly = today;
  }
  if (result.daily || result.weekly) await writeState(env, state);
  return result;
}
