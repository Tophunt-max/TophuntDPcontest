/**
 * Refunds and chargebacks, where the coins have to come back out.
 *
 * Two defects lived here, both invisible to the existing suite because it only
 * ever fired ONE refund event per payment and always against a properly credited
 * order:
 *
 *  1. The claim was keyed on the PAYMENT, and the first partial refund flipped the
 *     order straight to `refunded`. A second partial refund of the same payment
 *     was therefore indistinguishable from a duplicate delivery of the first and
 *     was dropped — so a payment refunded in two halves clawed back half the
 *     coins and the user kept the rest of a fully refunded purchase.
 *  2. `status = 'paid'` was treated as proof the coins had landed. It is not:
 *     `creditPaymentOrder` flips the status in a statement SEPARATE from the
 *     crediting batch, which is the whole reason `recoverStrandedPaidOrders`
 *     exists. Refunding such an order debited coins the user never received,
 *     recorded a shortfall, raised an admin alert accusing them of refund farming,
 *     and then made the order terminal — removing it from the recovery sweep so
 *     the lost credit could never be found.
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

import { makeEnv, drizzleOf, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';
import { clawbackPaymentOrder, creditPaymentOrder } from '../src/lib/coinOrders';

async function seedUser(env: TestEnv, uid: string, dpcoin = 0) {
  const ts = Date.now();
  await drizzleOf(env)
    .insert(schema.users)
    .values({ uid, username: uid, fullName: uid, dpcoin, createdAt: ts, updatedAt: ts } as any);
}

const balanceOf = async (env: TestEnv, uid: string) =>
  Number(
    (await drizzleOf(env).select().from(schema.users).where(eq(schema.users.uid, uid)).get())?.dpcoin ?? 0,
  );

const orderOf = async (env: TestEnv, orderId: string) =>
  drizzleOf(env).select().from(schema.paymentOrders).where(eq(schema.paymentOrders.orderId, orderId)).get();

const paymentOf = async (env: TestEnv, id: string) =>
  drizzleOf(env).select().from(schema.payments).where(eq(schema.payments.id, id)).get();

const clawbackLedger = async (env: TestEnv, uid: string) =>
  (await drizzleOf(env).select().from(schema.coinTransactions).where(eq(schema.coinTransactions.uid, uid)).all())
    .filter((r) => r.type === 'refund_clawback' || r.type === 'chargeback_clawback');

/** A `paid` order whose coins DID land (a `payments` row exists). */
async function seedCreditedOrder(
  env: TestEnv,
  uid: string,
  { coins = 100, paise = 10000, orderId = 'order_1', paymentId = 'pay_1' } = {},
) {
  const db = drizzleOf(env);
  const ts = Date.now();
  await db.insert(schema.paymentOrders).values({
    orderId, userId: uid, packageId: 'p1', coins, bonusCoins: 0, amountPaise: paise,
    currency: 'INR', status: 'paid', paymentId, source: 'callback', creditedAt: ts,
    createdAt: ts, updatedAt: ts,
  } as any);
  await db.insert(schema.payments).values({
    id: paymentId, userId: uid, amount: coins, coins, amountPaise: paise,
    source: 'razorpay', status: 'success', createdAt: ts,
  } as any);
  return { orderId, paymentId, coins };
}

// ===========================================================================
describe('partial refunds accumulate', () => {
  it('two half refunds of one payment claw back the whole purchase', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 100);
    const { paymentId, orderId } = await seedCreditedOrder(env, 'alice');

    // Refund #1 — ₹50 of ₹100.
    const first = await clawbackPaymentOrder(env as any, drizzleOf(env), {
      paymentId, kind: 'refund', refundedAmountPaise: 5000, refundId: 'rfnd_1',
    });
    expect(first.clawedBack).toBe(true);
    expect(first.coins).toBe(50);
    expect(first.fullyRefunded).toBe(false);
    expect(await balanceOf(env, 'alice')).toBe(50);
    // Not terminal: still open to the rest of the refund.
    expect((await orderOf(env, orderId))?.status).toBe('partially_refunded');

    // Refund #2 — the other ₹50. THIS is what used to be swallowed as a replay.
    const second = await clawbackPaymentOrder(env as any, drizzleOf(env), {
      paymentId, kind: 'refund', refundedAmountPaise: 5000, refundId: 'rfnd_2',
    });
    expect(second.clawedBack).toBe(true);
    expect(second.coins).toBe(50);
    expect(second.fullyRefunded).toBe(true);

    expect(await balanceOf(env, 'alice')).toBe(0);
    const order = await orderOf(env, orderId);
    expect(order?.status).toBe('refunded');
    // Cumulative, not overwritten — the old code lost the first refund's amount.
    expect(Number(order?.refundedAmountPaise)).toBe(10000);
    expect(Number(order?.clawedBackCoins)).toBe(100);
    // One ledger row per refund, each with its own id.
    const ledger = await clawbackLedger(env, 'alice');
    expect(ledger).toHaveLength(2);
    expect(ledger.map((r) => Number(r.amount)).sort()).toEqual([-50, -50]);
  });

  it('a duplicate delivery of the SAME refund is still a no-op', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 100);
    const { paymentId } = await seedCreditedOrder(env, 'alice');

    await clawbackPaymentOrder(env as any, drizzleOf(env), {
      paymentId, kind: 'refund', refundedAmountPaise: 5000, refundId: 'rfnd_1',
    });
    const dup = await clawbackPaymentOrder(env as any, drizzleOf(env), {
      paymentId, kind: 'refund', refundedAmountPaise: 5000, refundId: 'rfnd_1',
    });

    expect(dup.clawedBack).toBe(false);
    expect(await balanceOf(env, 'alice')).toBe(50);
    expect(await clawbackLedger(env, 'alice')).toHaveLength(1);
  });

  /**
   * Rounding is proportional on the CUMULATIVE total, so `Math.ceil` cannot
   * compound: three ~33% refunds must reverse 100 coins, not 102.
   */
  it('rounds up without compounding across several refunds', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 100);
    const { paymentId } = await seedCreditedOrder(env, 'alice', { coins: 100, paise: 10000 });

    const a = await clawbackPaymentOrder(env as any, drizzleOf(env), {
      paymentId, kind: 'refund', refundedAmountPaise: 3334, refundId: 'r1',
    });
    const b = await clawbackPaymentOrder(env as any, drizzleOf(env), {
      paymentId, kind: 'refund', refundedAmountPaise: 3333, refundId: 'r2',
    });
    const c = await clawbackPaymentOrder(env as any, drizzleOf(env), {
      paymentId, kind: 'refund', refundedAmountPaise: 3333, refundId: 'r3',
    });

    expect((a.coins ?? 0) + (b.coins ?? 0) + (c.coins ?? 0)).toBe(100);
    expect(await balanceOf(env, 'alice')).toBe(0);
  });

  it('a refund event cannot claw back more than the captured amount', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 100);
    const { paymentId, orderId } = await seedCreditedOrder(env, 'alice');

    // A gateway event claiming more than was captured.
    const res = await clawbackPaymentOrder(env as any, drizzleOf(env), {
      paymentId, kind: 'refund', refundedAmountPaise: 999999, refundId: 'r1',
    });

    expect(res.coins).toBe(100);
    expect(await balanceOf(env, 'alice')).toBe(0);
    expect(Number((await orderOf(env, orderId))?.refundedAmountPaise)).toBe(10000);
  });

  it('marks the payment partially_refunded so revenue is not written off whole', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 100);
    const { paymentId } = await seedCreditedOrder(env, 'alice');

    await clawbackPaymentOrder(env as any, drizzleOf(env), {
      paymentId, kind: 'refund', refundedAmountPaise: 2000, refundId: 'r1',
    });

    expect((await paymentOf(env, paymentId))?.status).toBe('partially_refunded');
  });

  it('a partially refunded order can never be re-credited', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 100);
    const { paymentId, orderId } = await seedCreditedOrder(env, 'alice');
    await clawbackPaymentOrder(env as any, drizzleOf(env), {
      paymentId, kind: 'refund', refundedAmountPaise: 5000, refundId: 'r1',
    });

    // A late duplicate `payment.captured` retry.
    const credit = await creditPaymentOrder(env as any, drizzleOf(env), {
      orderId, paymentId, source: 'webhook',
    });

    expect(credit.credited).toBe(false);
    expect(await balanceOf(env, 'alice')).toBe(50);
  });
});

// ===========================================================================
describe('refunding an order whose coins never landed', () => {
  /** `paid` with a payment id but NO `payments` row — the stranded fingerprint. */
  async function seedStrandedOrder(env: TestEnv, uid: string) {
    const ts = Date.now();
    await drizzleOf(env).insert(schema.paymentOrders).values({
      orderId: 'order_s', userId: uid, packageId: 'p1', coins: 100, bonusCoins: 0,
      amountPaise: 10000, currency: 'INR', status: 'paid', paymentId: 'pay_s',
      source: 'callback', creditedAt: ts, createdAt: ts, updatedAt: ts,
    } as any);
    return { orderId: 'order_s', paymentId: 'pay_s' };
  }

  it('debits nothing and accuses nobody', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 0); // the credit never applied
    const { paymentId, orderId } = await seedStrandedOrder(env, 'alice');

    const res = await clawbackPaymentOrder(env as any, drizzleOf(env), {
      paymentId, kind: 'refund', refundId: 'r1',
    });

    expect(res.clawedBack).toBe(false);
    expect(res.reason).toBe('not_credited');
    // The critical assertion: an innocent balance is NOT driven negative.
    expect(await balanceOf(env, 'alice')).toBe(0);
    expect(await clawbackLedger(env, 'alice')).toHaveLength(0);
    const order = await orderOf(env, orderId);
    // No refund-farming evidence recorded against them.
    expect(Number(order?.clawbackShortfall ?? 0)).toBe(0);
    // Still made terminal: the customer's money went back, so it must never be
    // credited by a late capture retry.
    expect(order?.status).toBe('refunded');
  });

  it('a chargeback on a stranded order is equally harmless', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 0);
    const { paymentId } = await seedStrandedOrder(env, 'alice');

    const res = await clawbackPaymentOrder(env as any, drizzleOf(env), {
      paymentId, kind: 'dispute', refundId: 'dsp_1',
    });

    expect(res.clawedBack).toBe(false);
    expect(await balanceOf(env, 'alice')).toBe(0);
  });
});

// ===========================================================================
describe('clawback bookkeeping', () => {
  /**
   * The shortfall is computed INSIDE the batch. It used to come from a balance read
   * taken before it, so any concurrent spend or settlement made the persisted
   * figure — and the admin alert built on it — numerically wrong.
   */
  it('records the shortfall against the balance the debit actually saw', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 20); // 80 of the 100 purchased coins already spent
    const { paymentId, orderId } = await seedCreditedOrder(env, 'alice');

    const res = await clawbackPaymentOrder(env as any, drizzleOf(env), {
      paymentId, kind: 'dispute', refundId: 'dsp_1',
    });

    expect(res.shortfall).toBe(80);
    expect(await balanceOf(env, 'alice')).toBe(-80);
    const order = await orderOf(env, orderId);
    expect(Number(order?.clawbackShortfall)).toBe(80);
    expect(order?.status).toBe('disputed');
  });

  /**
   * The success probe is the ORDER update, not the user debit. Reading the debit
   * meant a deleted account reported "already" for a clawback whose status flip and
   * ledger row HAD applied — so the caller skipped the notification and the
   * shortfall alert for a reversal that really happened.
   */
  it('reports success when the order was reversed even if the account is gone', async () => {
    const { env } = makeEnv();
    const { paymentId, orderId } = await seedCreditedOrder(env, 'ghost');
    // No `users` row for 'ghost' — the account was erased after paying.

    const res = await clawbackPaymentOrder(env as any, drizzleOf(env), {
      paymentId, kind: 'refund', refundId: 'r1',
    });

    expect(res.clawedBack).toBe(true);
    expect((await orderOf(env, orderId))?.status).toBe('refunded');
  });

  it('a fully refunded order stays terminal against any further event', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 100);
    const { paymentId } = await seedCreditedOrder(env, 'alice');
    await clawbackPaymentOrder(env as any, drizzleOf(env), { paymentId, kind: 'refund', refundId: 'r1' });

    const later = await clawbackPaymentOrder(env as any, drizzleOf(env), {
      paymentId, kind: 'refund', refundedAmountPaise: 5000, refundId: 'r2',
    });

    expect(later.clawedBack).toBe(false);
    expect(later.reason).toBe('already');
    expect(await balanceOf(env, 'alice')).toBe(0);
  });
});
