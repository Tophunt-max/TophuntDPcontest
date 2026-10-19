/**
 * Withdrawal platform fee (lib/withdrawalFee.ts).
 *
 * Pinned: the fee is percent + flat, clamped to [min, max], never more than the
 * payout; it is DEDUCTED from the rupees paid (the coins escrowed are exactly
 * what was requested); it is locked on the row at request time; a stale quote is
 * refused; a sub-₹1 net payout is refused; a rejection refunds every coin.
 *
 * The vectors below are duplicated in apps/expo/test/withdrawalFee.test.ts so the
 * app's preview can never disagree with what the server charges.
 */
import { vi, describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';

vi.mock('../src/lib/firebaseAuth', () => ({
  verifyIdToken: async (token: string) => {
    const [uid, role] = token.split(':');
    return { uid, role: role || 'user' };
  },
  bearerToken: (h?: string | null) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
}));

import { makeEnv, makeApp, fakeCtx, drizzleOf, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';
import { quoteWithdrawal, feeRuleFromConfig } from '../src/lib/withdrawalFee';

const app = makeApp();

export const FEE_VECTORS: { coins: number; rate: number; rule: any; gross: number; fee: number; net: number }[] = [
  // No fee configured.
  { coins: 100, rate: 0.1, rule: {}, gross: 10, fee: 0, net: 10 },
  // 5% + ₹2 flat.
  { coins: 100, rate: 0.1, rule: { feePercent: 5, feeFlat: 2 }, gross: 10, fee: 2.5, net: 7.5 },
  // Minimum fee wins on a small payout.
  { coins: 200, rate: 0.1, rule: { feePercent: 2, feeMin: 3 }, gross: 20, fee: 3, net: 17 },
  // Maximum fee caps a large payout.
  { coins: 100000, rate: 0.1, rule: { feePercent: 10, feeMax: 50 }, gross: 10000, fee: 50, net: 9950 },
  // Rounded to the paisa.
  { coins: 333, rate: 0.1, rule: { feePercent: 2.5 }, gross: 33.3, fee: 0.83, net: 32.47 },
  // Never more than the payout.
  { coins: 10, rate: 0.1, rule: { feeFlat: 5 }, gross: 1, fee: 1, net: 0 },
];

describe('fee formula', () => {
  for (const v of FEE_VECTORS) {
    it(`${v.coins} coins @ ₹${v.rate} with ${JSON.stringify(v.rule)} -> fee ₹${v.fee}, net ₹${v.net}`, () => {
      const q = quoteWithdrawal(v.coins, v.rate, feeRuleFromConfig({ withdrawal: v.rule }));
      expect([q.grossInr, q.feeInr, q.netInr]).toEqual([v.gross, v.fee, v.net]);
    });
  }
  it('ignores negative / junk values and caps the percent at 50', () => {
    const r = feeRuleFromConfig({ withdrawal: { feePercent: 90, feeFlat: -3, feeMin: 'x' } });
    expect(r).toEqual({ feePercent: 50, feeFlat: 0, feeMin: 0, feeMax: 0 });
  });
});

async function seedUser(env: TestEnv, uid: string, dpcoin: number) {
  await drizzleOf(env).insert(schema.users).values({ signupCompleted: true, uid, username: uid, fullName: uid, dpcoin, createdAt: 1, updatedAt: 1 } as any);
}
async function seedConfig(env: TestEnv, withdrawal: Record<string, any>) {
  await drizzleOf(env).insert(schema.settings).values({ id: 'appConfig', data: { withdrawal } as any, updatedAt: Date.now() } as any);
  await env.CACHE_KV.delete('settings:appConfig');
}
async function call(env: TestEnv, token: string, route: string, body: any, method = 'POST') {
  const res = await app.request(
    route,
    { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Admin-Secret': token === 'admin' ? 'test-admin-secret' : '' }, body: JSON.stringify(body) },
    env,
    fakeCtx(),
  );
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}
const withdraw = (env: TestEnv, data: any) => call(env, 'alice', '/api', { action: 'requestWithdrawal', method: 'upi', accountDetails: 'alice@okbank', ...data });

describe('requestWithdrawal with a platform fee', () => {
  it('deducts the fee from the payout, escrows exactly the coins requested, and locks the breakdown', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 500);
    await seedConfig(env, { conversionRate: 0.1, feePercent: 5, feeFlat: 2 });
    const r = await withdraw(env, { amount: 100, quotedFee: 2.5 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ grossAmount: 10, feeAmount: 2.5, cashAmount: 7.5 });
    const row = await drizzleOf(env).select().from(schema.withdrawals).where(eq(schema.withdrawals.userId, 'alice')).get();
    expect(row).toMatchObject({ amount: 100, grossAmount: 10, feeAmount: 2.5, cashAmount: 7.5 });
    expect(JSON.parse(String(row?.feeDetail))).toEqual({ feePercent: 5, feeFlat: 2, feeMin: 0, feeMax: 0 });
    const u = await drizzleOf(env).select().from(schema.users).where(eq(schema.users.uid, 'alice')).get();
    expect(Number(u?.dpcoin)).toBe(400);

    // A later fee change never touches the request already made.
    await drizzleOf(env).update(schema.settings).set({ data: { withdrawal: { conversionRate: 0.1, feePercent: 20 } } as any }).where(eq(schema.settings.id, 'appConfig'));
    await env.CACHE_KV.delete('settings:appConfig');
    const again = await drizzleOf(env).select().from(schema.withdrawals).where(eq(schema.withdrawals.id, row!.id)).get();
    expect(Number(again?.cashAmount)).toBe(7.5);
  });

  it('refuses when the quote the user saw no longer matches the live fee', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 500);
    await seedConfig(env, { conversionRate: 0.1, feePercent: 10 });
    const r = await withdraw(env, { amount: 100, quotedFee: 0 });
    expect(r.status).toBe(412);
    expect(JSON.stringify(r.body)).toContain('FEE_CHANGED');
    expect(await drizzleOf(env).select().from(schema.withdrawals).all()).toHaveLength(0);
  });

  it('refuses a payout under ₹1 after the fee, without reserving coins', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 500);
    await seedConfig(env, { conversionRate: 0.1, feeFlat: 5 });
    const r = await withdraw(env, { amount: 50 });
    expect(r.status).toBe(412);
    const u = await drizzleOf(env).select().from(schema.users).where(eq(schema.users.uid, 'alice')).get();
    expect(Number(u?.dpcoin)).toBe(500);
  });

  it('a rejected request refunds every coin — no fee is kept', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 500);
    await seedConfig(env, { conversionRate: 0.1, feePercent: 5, feeFlat: 2 });
    const r = await withdraw(env, { amount: 100 });
    expect(r.status).toBe(200);
    const rej = await call(env, 'admin', `/admin/withdrawals/${r.body.withdrawalId}`, { action: 'reject', adminNote: 'test' }, 'PATCH');
    expect(rej.status).toBe(200);
    const u = await drizzleOf(env).select().from(schema.users).where(eq(schema.users.uid, 'alice')).get();
    expect(Number(u?.dpcoin)).toBe(500);
  });
});

describe('admin settings', () => {
  it('validates the fee fields and exposes them to the app', async () => {
    const { env } = makeEnv();
    expect((await call(env, 'admin', '/admin/app-settings', { withdrawal: { feePercent: 80 } })).status).toBe(400);
    expect((await call(env, 'admin', '/admin/app-settings', { withdrawal: { feeMin: 10, feeMax: 5 } })).status).toBe(400);
    expect((await call(env, 'admin', '/admin/app-settings', { withdrawal: { feePercent: 5, feeFlat: 2, feeMin: 1, feeMax: 50 } })).status).toBe(200);
    const res = await app.request('/read/app-config', {}, env, fakeCtx());
    const cfg: any = await res.json();
    expect(cfg.withdrawal).toMatchObject({ feePercent: 5, feeFlat: 2, feeMin: 1, feeMax: 50 });
  });
});
