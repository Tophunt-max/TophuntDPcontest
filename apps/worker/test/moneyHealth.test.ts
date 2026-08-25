/**
 * Money-flow integrity console.
 *
 * The core invariant of the coin economy is `users.dpcoin == SUM(ledger)` for
 * every user — a drift means coins were minted or burned without a ledger row,
 * the one bug you must never find out about late. This proves computeMoneyHealth
 * actually detects that (and the other real money leaks), and that a clean books
 * reads green. The queries are raw SQL over the D1 shim, so this is also what
 * catches a typo in one of them.
 */
import { describe, it, expect } from 'vitest';
import { computeMoneyHealth } from '../src/lib/moneyHealth';
import { makeEnv, drizzleOf } from './helpers/harness';
import { schema } from '../src/db';

/** Seed a user with a balance and (optionally) matching ledger rows. */
async function user(db: ReturnType<typeof drizzleOf>, uid: string, dpcoin: number) {
  await db.insert(schema.users).values({ uid, dpcoin, createdAt: Date.now(), updatedAt: Date.now() } as any).run();
}
async function ledger(db: ReturnType<typeof drizzleOf>, uid: string, amount: number, type = 'admin_adjust') {
  await db.insert(schema.coinTransactions).values({
    id: `${uid}-${amount}-${Math.random()}`, uid, amount, type, createdAt: Date.now(),
  }).run();
}

describe('computeMoneyHealth — ledger drift (the core invariant)', () => {
  it('is clean when every balance equals its ledger sum', async () => {
    const { env } = makeEnv();
    const db = drizzleOf(env);
    await user(db, 'alice', 100);
    await ledger(db, 'alice', 60, 'purchase');
    await ledger(db, 'alice', 40, 'reward');

    const h = await computeMoneyHealth(env);
    expect(h.ledgerDrift.count).toBe(0);
    expect(h.ok).toBe(true);
  });

  it('flags a user whose balance does not match the ledger', async () => {
    const { env } = makeEnv();
    const db = drizzleOf(env);
    // Balance 100 but ledger only accounts for 70 → 30 coins appeared unledgered.
    await user(db, 'bob', 100);
    await ledger(db, 'bob', 70, 'purchase');

    const h = await computeMoneyHealth(env);
    expect(h.ledgerDrift.count).toBe(1);
    expect(h.ok).toBe(false);
    const sample = h.ledgerDrift.samples.find((s) => s.uid === 'bob')!;
    expect(sample.balance).toBe(100);
    expect(sample.ledger).toBe(70);
    expect(sample.diff).toBeCloseTo(30);
  });

  it('treats a user with no ledger rows and a zero balance as consistent', async () => {
    const { env } = makeEnv();
    const db = drizzleOf(env);
    await user(db, 'carol', 0);
    const h = await computeMoneyHealth(env);
    expect(h.ledgerDrift.count).toBe(0);
  });
});

describe('computeMoneyHealth — negative balances', () => {
  it('flags a balance below zero', async () => {
    const { env } = makeEnv();
    const db = drizzleOf(env);
    await user(db, 'dave', -5);
    await ledger(db, 'dave', -5, 'contest_entry_fee');

    const h = await computeMoneyHealth(env);
    expect(h.negativeBalances.count).toBe(1);
    expect(h.negativeBalances.samples[0]).toMatchObject({ uid: 'dave', balance: -5 });
    expect(h.ok).toBe(false);
  });
});

describe('computeMoneyHealth — payment orders', () => {
  it('counts a paid order whose coins never landed (no payments row)', async () => {
    const { env } = makeEnv();
    const db = drizzleOf(env);
    const ts = Date.now();
    await db.insert(schema.paymentOrders).values({
      orderId: 'ord_stranded', userId: 'u1', coins: 100, amountPaise: 10000, currency: 'INR',
      status: 'paid', paymentId: 'pay_missing', createdAt: ts, updatedAt: ts,
    } as any).run();

    const h = await computeMoneyHealth(env);
    expect(h.strandedPaidOrders).toBe(1);
    expect(h.ok).toBe(false);
  });

  it('does NOT count a paid order that has its payments row', async () => {
    const { env } = makeEnv();
    const db = drizzleOf(env);
    const ts = Date.now();
    await db.insert(schema.paymentOrders).values({
      orderId: 'ord_ok', userId: 'u1', coins: 100, amountPaise: 10000, currency: 'INR',
      status: 'paid', paymentId: 'pay_ok', createdAt: ts, updatedAt: ts,
    } as any).run();
    await db.insert(schema.payments).values({
      id: 'pay_ok', userId: 'u1', amount: 100, coins: 100, amountPaise: 10000, source: 'razorpay', status: 'success', createdAt: ts,
    } as any).run();

    const h = await computeMoneyHealth(env);
    expect(h.strandedPaidOrders).toBe(0);
  });

  it('counts an order stuck in created past the reconcile window, but not a fresh one', async () => {
    const { env } = makeEnv();
    const db = drizzleOf(env);
    const ts = Date.now();
    await db.insert(schema.paymentOrders).values({
      orderId: 'ord_stuck', userId: 'u1', coins: 50, amountPaise: 5000, currency: 'INR',
      status: 'created', createdAt: ts - 20 * 60 * 1000, updatedAt: ts,
    } as any).run();
    await db.insert(schema.paymentOrders).values({
      orderId: 'ord_fresh', userId: 'u1', coins: 50, amountPaise: 5000, currency: 'INR',
      status: 'created', createdAt: ts, updatedAt: ts,
    } as any).run();

    const h = await computeMoneyHealth(env);
    expect(h.stuckCreatedOrders).toBe(1);
    // Stuck `created` orders are a reconcile-lag signal, not an invariant breach.
    expect(h.ok).toBe(true);
  });

  it('sums clawback shortfalls (refund-farming signal)', async () => {
    const { env } = makeEnv();
    const db = drizzleOf(env);
    const ts = Date.now();
    await db.insert(schema.paymentOrders).values({
      orderId: 'ord_claw', userId: 'u1', coins: 100, amountPaise: 10000, currency: 'INR',
      status: 'refunded', clawbackShortfall: 30, createdAt: ts, updatedAt: ts,
    } as any).run();

    const h = await computeMoneyHealth(env);
    expect(h.clawbackShortfalls.count).toBe(1);
    expect(h.clawbackShortfalls.coins).toBeCloseTo(30);
    expect(h.ok).toBe(false);
  });
});

describe('computeMoneyHealth — pending queues (informational)', () => {
  it('reports pending deposits/withdrawals with the oldest age, without failing health', async () => {
    const { env } = makeEnv();
    const db = drizzleOf(env);
    const ts = Date.now();
    await db.insert(schema.deposits).values({
      id: 'd1', userId: 'u1', amount: 100, payAmount: 100, status: 'pending', createdAt: ts - 60_000, updatedAt: ts,
    } as any).run();
    await db.insert(schema.withdrawals).values({
      id: 'w1', userId: 'u1', amount: 50, cashAmount: 50, status: 'pending', createdAt: ts - 120_000, updatedAt: ts,
    } as any).run();

    const h = await computeMoneyHealth(env);
    expect(h.pendingDeposits.count).toBe(1);
    expect(h.pendingDeposits.oldestAgeMs).toBeGreaterThanOrEqual(60_000);
    expect(h.pendingWithdrawals.count).toBe(1);
    expect(h.pendingWithdrawals.oldestAgeMs).toBeGreaterThanOrEqual(120_000);
    // Queues alone do not make the books unhealthy.
    expect(h.ok).toBe(true);
  });
});

describe('GET /admin/money-health route', () => {
  it('returns the health payload to a full admin', async () => {
    const { makeApp } = await import('./helpers/harness');
    const { env } = makeEnv();
    const db = drizzleOf(env);
    await user(db, 'bob', 100);
    await ledger(db, 'bob', 70, 'purchase');

    const app = makeApp();
    const res = await app.request('/admin/money-health', { headers: { 'X-Admin-Secret': 'test-admin-secret' } }, env);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.ledgerDrift.count).toBe(1);
    expect(body.ok).toBe(false);
  });
});
