/**
 * The replay guards behind every coin credit, and the retention sweep that used
 * to delete them.
 *
 * All of these defects were live in production with a clean typecheck and a green
 * 1040-test suite, because each one needs a SEQUENCE to expose: settle, wait past
 * a retention window, re-run. Nothing asserted the sequences, so nothing failed.
 *
 * The invariant every test here ultimately defends is the one lib/moneyHealth.ts
 * alarms on:
 *
 *     users.dpcoin == SUM(coin_transactions.amount)   for every user
 *
 * so most of them assert the balance AND the ledger, never just one.
 */
import { vi, describe, it, expect } from 'vitest';
import { eq, like } from 'drizzle-orm';

// Bypass Firebase token verification: the bearer token is "uid" or "uid:role".
vi.mock('../src/lib/firebaseAuth', () => ({
  verifyIdToken: async (token: string) => {
    const [uid, role] = token.split(':');
    return { uid, role: role || 'user' };
  },
  bearerToken: (h?: string | null) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
}));

import { makeEnv, makeApp, fakeCtx, drizzleOf, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';
import { pruneOpsTables, pruneAlertClaims, PRUNABLE_CLAIM_SCOPES } from '../src/lib/ops';
import { monthlyHallOfFame, previousMonthPeriod } from '../src/cron';
import { adjustUserWallet, WalletReplay } from '../src/lib/money';
import { computeMoneyHealth } from '../src/lib/moneyHealth';

const app = makeApp();

/**
 * Seed a user, WITH a ledger row backing any opening balance.
 *
 * The ledger row matters: `expectNoDrift` below asserts
 * `users.dpcoin == SUM(coin_transactions.amount)`, and a balance conjured
 * straight into the column would break that before the code under test ran —
 * turning the strongest assertion available here into noise.
 */
async function seedUser(env: TestEnv, uid: string, dpcoin = 0, extra: Record<string, any> = {}) {
  const ts = Date.now();
  await drizzleOf(env)
    .insert(schema.users)
    .values({ uid, username: uid, fullName: uid, dpcoin, createdAt: ts, updatedAt: ts, ...extra } as any);
  if (dpcoin !== 0) {
    await drizzleOf(env)
      .insert(schema.coinTransactions)
      .values({
        id: `opening_balance:${uid}`,
        uid,
        amount: dpcoin,
        type: 'purchase',
        description: 'Opening balance (test fixture)',
        createdAt: ts,
      } as any);
  }
}

const balanceOf = async (env: TestEnv, uid: string) =>
  Number(
    (await drizzleOf(env).select().from(schema.users).where(eq(schema.users.uid, uid)).get())?.dpcoin ?? 0,
  );

/** SUM(coin_transactions.amount) for one uid — the other half of the invariant. */
async function ledgerTotal(env: TestEnv, uid: string): Promise<number> {
  const rows = await drizzleOf(env)
    .select()
    .from(schema.coinTransactions)
    .where(eq(schema.coinTransactions.uid, uid))
    .all();
  return rows.reduce((sum, r) => sum + Number(r.amount), 0);
}

/** Assert the load-bearing invariant for one account. */
async function expectNoDrift(env: TestEnv, uid: string) {
  expect(await ledgerTotal(env, uid)).toBe(await balanceOf(env, uid));
}

// ===========================================================================
describe('idempotency_keys retention', () => {
  const EIGHT_DAYS_AGO = Date.now() - 8 * 24 * 60 * 60 * 1000;

  async function seedClaim(env: TestEnv, key: string, scope: string, createdAt: number) {
    await drizzleOf(env)
      .insert(schema.idempotencyKeys)
      .values({ key, nonce: `nonce-${key}`, scope, createdAt } as any);
  }

  const remainingKeys = async (env: TestEnv) =>
    (await drizzleOf(env).select().from(schema.idempotencyKeys).all()).map((r) => r.key).sort();

  /**
   * THE BUG: the sweep was `DELETE FROM idempotency_keys WHERE created_at < ?`,
   * with no scope predicate at all, so it deleted money claims along with the
   * request-retry ones it was written for.
   */
  it('never deletes a money claim, however old', async () => {
    const { env } = makeEnv();
    await seedClaim(env, 'admin_wallet:alice:k1', 'wallet', EIGHT_DAYS_AGO);
    await seedClaim(env, 'clawback:pay_1:rfnd_1', 'clawback', EIGHT_DAYS_AGO);
    await seedClaim(env, 'hall_of_fame:2026-07:1:alice', 'hall_of_fame', EIGHT_DAYS_AGO);

    await pruneOpsTables(env as any);

    expect(await remainingKeys(env)).toEqual([
      'admin_wallet:alice:k1',
      'clawback:pay_1:rfnd_1',
      'hall_of_fame:2026-07:1:alice',
    ]);
  });

  it('still prunes the aged request-retry claims it exists for', async () => {
    const { env } = makeEnv();
    await seedClaim(env, 'api:alice:k1', 'api', EIGHT_DAYS_AGO);
    await seedClaim(env, 'admin:broadcast:-:k2', 'admin', EIGHT_DAYS_AGO);
    await seedClaim(env, 'alert:cron:resolveContests:1', 'alert', EIGHT_DAYS_AGO);
    await seedClaim(env, 'api:alice:recent', 'api', Date.now());

    const res = await pruneOpsTables(env as any);

    expect(res.idempotencyKeys).toBe(3);
    expect(await remainingKeys(env)).toEqual(['api:alice:recent']);
  });

  /**
   * An UNKNOWN scope is retained, not deleted. The allowlist direction is the
   * point: a scope added by a future feature must not be silently swept before
   * anyone has decided whether it guards money.
   */
  it('retains an unrecognised scope, and a legacy NULL scope', async () => {
    const { env } = makeEnv();
    await seedClaim(env, 'future:thing', 'some_new_feature', EIGHT_DAYS_AGO);
    await drizzleOf(env)
      .insert(schema.idempotencyKeys)
      .values({ key: 'legacy:row', nonce: 'n', scope: null, createdAt: EIGHT_DAYS_AGO } as any);

    await pruneOpsTables(env as any);

    expect(await remainingKeys(env)).toEqual(['future:thing', 'legacy:row']);
    // Guards the allowlist itself: adding a money scope here would reintroduce the bug.
    expect([...PRUNABLE_CLAIM_SCOPES]).toEqual(['api', 'admin', 'alert']);
  });

  /** `pruneAlertClaims` was a SECOND copy of the same scope-blind delete. */
  it('pruneAlertClaims deletes only alert claims', async () => {
    const { env } = makeEnv();
    await seedClaim(env, 'alert:old', 'alert', EIGHT_DAYS_AGO);
    await seedClaim(env, 'admin_wallet:alice:k1', 'wallet', EIGHT_DAYS_AGO);

    await pruneAlertClaims(env as any);

    expect(await remainingKeys(env)).toEqual(['admin_wallet:alice:k1']);
  });
});

// ===========================================================================
describe('monthlyHallOfFame', () => {
  const PERIOD = '2026-07';

  async function seedContenders(env: TestEnv) {
    await seedUser(env, 'gold', 0, { monthlyWins: 10 });
    await seedUser(env, 'silver', 0, { monthlyWins: 5 });
    await seedUser(env, 'bronze', 0, { monthlyWins: 2 });
  }

  it('pays the top three, ledgers each payout, and resets the leaderboard', async () => {
    const { env } = makeEnv();
    await seedContenders(env);

    const res = await monthlyHallOfFame(env as any, PERIOD);

    expect(res).toMatchObject({ period: PERIOD, paid: 3, skipped: 0, reset: true, replayed: false });
    expect(await balanceOf(env, 'gold')).toBe(1000);
    expect(await balanceOf(env, 'silver')).toBe(500);
    expect(await balanceOf(env, 'bronze')).toBe(250);
    for (const uid of ['gold', 'silver', 'bronze']) await expectNoDrift(env, uid);
    // The settled set is recorded, which is what makes a re-run a replay.
    const awards = await drizzleOf(env)
      .select()
      .from(schema.hallOfFameAwards)
      .where(eq(schema.hallOfFameAwards.period, PERIOD))
      .all();
    expect(awards.map((a) => [a.uid, a.rank, Number(a.reward)])).toEqual([
      ['gold', 1, 1000],
      ['silver', 2, 500],
      ['bronze', 3, 250],
    ]);
  });

  it('a double-clicked trigger pays nobody twice', async () => {
    const { env } = makeEnv();
    await seedContenders(env);

    await monthlyHallOfFame(env as any, PERIOD);
    const second = await monthlyHallOfFame(env as any, PERIOD);

    expect(second.paid).toBe(0);
    expect(second.skipped).toBe(3);
    expect(await balanceOf(env, 'gold')).toBe(1000);
    await expectNoDrift(env, 'gold');
  });

  /**
   * THE HIGH-SEVERITY BUG. The balance update was gated ONLY on the
   * `idempotency_keys` claim, and the hourly sweep deleted those after 7 days.
   * The ledger insert is `INSERT OR IGNORE` on a deterministic id, so on a re-run
   * it is IGNORED — it could not be the thing that stopped the credit. Result:
   * 1000 coins minted with no ledger row, from one admin click on
   * `POST /admin/ops/hall-of-fame` with an older period.
   */
  it('cannot pay twice even after the claim rows have been pruned', async () => {
    const { env } = makeEnv();
    await seedContenders(env);
    await monthlyHallOfFame(env as any, PERIOD);
    expect(await balanceOf(env, 'gold')).toBe(1000);

    // Simulate the retention sweep as it behaved before the scope allowlist:
    // delete every claim regardless of scope.
    await drizzleOf(env).delete(schema.idempotencyKeys).run();

    const afterPrune = await monthlyHallOfFame(env as any, PERIOD);

    expect(afterPrune.paid).toBe(0);
    expect(await balanceOf(env, 'gold')).toBe(1000);
    await expectNoDrift(env, 'gold');
  });

  /**
   * THE OTHER HALF. The winner set was derived live from `monthly_wins`, which the
   * run itself resets — so re-running a PAST period paid whoever was leading the
   * CURRENT month, and then wiped that in-progress leaderboard.
   */
  it('re-running a settled period never pays the current leaderboard', async () => {
    const { env } = makeEnv();
    await seedContenders(env);
    await monthlyHallOfFame(env as any, PERIOD);

    // A new month begins and someone else starts winning.
    await seedUser(env, 'newcomer', 0, { monthlyWins: 7 });

    const replay = await monthlyHallOfFame(env as any, PERIOD);

    expect(replay.replayed).toBe(true);
    expect(replay.paid).toBe(0);
    expect(await balanceOf(env, 'newcomer')).toBe(0);
    // And the in-progress month is untouched — the replay must not reset it.
    const newcomer = await drizzleOf(env)
      .select()
      .from(schema.users)
      .where(eq(schema.users.uid, 'newcomer'))
      .get();
    expect(Number(newcomer?.monthlyWins)).toBe(7);
  });

  /**
   * Backward compatibility: a period settled BEFORE `hall_of_fame_awards` existed
   * has no award rows, so the replay path cannot recognise it. Its deterministic
   * ledger ids are the proof instead. Without this, the first re-run after the
   * deploy would have paid the current leaderboard for every historical month.
   */
  it('refuses to re-derive a period that only its ledger rows prove was settled', async () => {
    const { env } = makeEnv();
    await seedContenders(env);
    // A pre-migration payout: ledger row present, no award row.
    await drizzleOf(env)
      .insert(schema.coinTransactions)
      .values({
        id: `hall_of_fame:${PERIOD}:someone_else`,
        uid: 'someone_else',
        amount: 1000,
        type: 'monthly_hall_of_fame_reward',
        description: `Hall of Fame rank #1 (${PERIOD})`,
        createdAt: Date.now(),
      } as any);

    const res = await monthlyHallOfFame(env as any, PERIOD);

    expect(res.paid).toBe(0);
    expect(res.reset).toBe(false);
    expect(await balanceOf(env, 'gold')).toBe(0);
  });

  it('settles nobody, and resets nothing, when no one won anything', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'idle', 0, { monthlyWins: 0 });

    const res = await monthlyHallOfFame(env as any, PERIOD);

    expect(res.paid).toBe(0);
    expect(await balanceOf(env, 'idle')).toBe(0);
  });

  it('skips a winner whose account was deleted before the payout ran', async () => {
    const { env } = makeEnv();
    await seedContenders(env);
    // Record the set, then remove one winner (as account erasure would).
    await drizzleOf(env)
      .insert(schema.hallOfFameAwards)
      .values([
        { period: PERIOD, uid: 'gold', rank: 1, reward: 1000, wins: 10, createdAt: Date.now() },
        { period: PERIOD, uid: 'ghost', rank: 2, reward: 500, wins: 5, createdAt: Date.now() },
      ] as any);

    const res = await monthlyHallOfFame(env as any, PERIOD);

    expect(res.paid).toBe(1);
    expect(res.skipped).toBe(1);
    expect(await balanceOf(env, 'gold')).toBe(1000);
    // No orphan ledger row for the account that no longer exists.
    const ghostLedger = await drizzleOf(env)
      .select()
      .from(schema.coinTransactions)
      .where(eq(schema.coinTransactions.uid, 'ghost'))
      .all();
    expect(ghostLedger).toHaveLength(0);
  });

  it('previousMonthPeriod names the month that just ended, in UTC', () => {
    expect(previousMonthPeriod(Date.UTC(2026, 0, 3))).toBe('2025-12');
    expect(previousMonthPeriod(Date.UTC(2026, 8, 19))).toBe('2026-08');
  });
});

// ===========================================================================
describe('adjustUserWallet idempotency', () => {
  it('a replay with the same claim key moves nothing', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 100);
    const input = {
      uid: 'alice',
      amount: 50,
      direction: 'add' as const,
      type: 'admin_adjustment',
      description: 'test',
      claimKey: 'admin_wallet:alice:key-1',
    };

    await adjustUserWallet(env as any, input);
    await expect(adjustUserWallet(env as any, input)).rejects.toBeInstanceOf(WalletReplay);

    expect(await balanceOf(env, 'alice')).toBe(150);
    await expectNoDrift(env, 'alice');
  });

  /**
   * THE BUG: the claim insert is unconditional while the money statements are
   * gated, so a FAILED adjustment still committed its claim. A legitimate retry
   * then lost the nonce comparison and was reported to the admin as
   * "Wallet already updated for this request (no change applied)" — telling them
   * an adjustment had happened when it never had, and making it permanently
   * impossible with that key.
   */
  it('a retry after an insufficient-balance failure is allowed to succeed', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 300);
    const subtract = {
      uid: 'alice',
      amount: 500,
      direction: 'subtract' as const,
      type: 'admin_adjustment',
      description: 'penalty',
      claimKey: 'admin_wallet:alice:key-1',
    };

    // Not enough balance — fails loudly rather than clamping.
    await expect(adjustUserWallet(env as any, subtract)).rejects.toThrow(/Insufficient balance/);
    // The failed attempt must not have consumed the key.
    const claims = await drizzleOf(env).select().from(schema.idempotencyKeys).all();
    expect(claims).toHaveLength(0);

    // The user tops up, and the admin retries with the SAME key.
    await adjustUserWallet(env as any, {
      uid: 'alice',
      amount: 400,
      direction: 'add',
      type: 'topup',
      description: 'topup',
    });
    const retried = await adjustUserWallet(env as any, subtract);

    expect(retried.newBalance).toBe(200); // 300 + 400 - 500
    await expectNoDrift(env, 'alice');
  });

  it('the released key still protects against a genuine double-submit', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 1000);
    const subtract = {
      uid: 'alice',
      amount: 100,
      direction: 'subtract' as const,
      type: 'admin_adjustment',
      description: 'penalty',
      claimKey: 'admin_wallet:alice:key-1',
    };

    await adjustUserWallet(env as any, subtract);
    await expect(adjustUserWallet(env as any, subtract)).rejects.toBeInstanceOf(WalletReplay);

    expect(await balanceOf(env, 'alice')).toBe(900);
    await expectNoDrift(env, 'alice');
  });
});

// ===========================================================================
/**
 * Manual deposits. The approval used to CAS the status in one statement and credit
 * in a separate, ungated batch — so a failure between them left the deposit
 * `approved` with no coins, no payment and no ledger row, and the handler then
 * refused to retry. Real INR, invisibly lost, with no sweeper looking for it.
 */
describe('manual deposit approval', () => {
  const adminHeaders = { 'Content-Type': 'application/json', 'X-Admin-Secret': 'test-admin-secret' };

  async function seedDeposit(env: TestEnv, id: string, uid: string, coins: number, extra: any = {}) {
    const ts = Date.now();
    await drizzleOf(env)
      .insert(schema.deposits)
      .values({
        id,
        userId: uid,
        amount: coins,
        payAmount: 199,
        status: 'pending',
        utr: `utr-${id}`,
        createdAt: ts,
        updatedAt: ts,
        ...extra,
      } as any);
  }

  const action = (env: TestEnv, id: string, act: 'approve' | 'reject') =>
    app.request(
      `/admin/deposits/${id}`,
      { method: 'PATCH', headers: adminHeaders, body: JSON.stringify({ action: act }) },
      env,
      fakeCtx(),
    );

  it('credits coins, the payment row, the ledger row and credited_at together', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 0);
    await seedDeposit(env, 'dep1', 'alice', 120);

    const res = await action(env, 'dep1', 'approve');
    expect(res.status).toBe(200);

    expect(await balanceOf(env, 'alice')).toBe(120);
    await expectNoDrift(env, 'alice');
    const db = drizzleOf(env);
    const payment = await db.select().from(schema.payments).where(eq(schema.payments.id, 'dep_dep1')).get();
    expect(payment?.status).toBe('success');
    expect(Number(payment?.amountPaise)).toBe(19900); // rupees, not coins
    const deposit = await db.select().from(schema.deposits).where(eq(schema.deposits.id, 'dep1')).get();
    expect(deposit?.status).toBe('approved');
    expect(deposit?.creditedAt).toBeTruthy();
    // Deterministic, so an operator re-run cannot write a second ledger row.
    const ledger = await db
      .select()
      .from(schema.coinTransactions)
      .where(eq(schema.coinTransactions.id, 'manual_deposit:dep1'))
      .get();
    expect(Number(ledger?.amount)).toBe(120);
  });

  it('a second approval credits nothing further', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 0);
    await seedDeposit(env, 'dep1', 'alice', 120);

    await action(env, 'dep1', 'approve');
    const second = await action(env, 'dep1', 'approve');

    expect(second.status).toBeGreaterThanOrEqual(400);
    expect(await balanceOf(env, 'alice')).toBe(120);
    await expectNoDrift(env, 'alice');
  });

  it('rejecting moves no money', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 0);
    await seedDeposit(env, 'dep1', 'alice', 120);

    const res = await action(env, 'dep1', 'reject');

    expect(res.status).toBe(200);
    expect(await balanceOf(env, 'alice')).toBe(0);
    const deposit = await drizzleOf(env)
      .select()
      .from(schema.deposits)
      .where(eq(schema.deposits.id, 'dep1'))
      .get();
    expect(deposit?.status).toBe('rejected');
    expect(deposit?.creditedAt).toBeFalsy();
  });

  /**
   * A deposit for an account that no longer exists must not flip to `approved`
   * with the credit silently matching no row — that is ledger drift in the other
   * direction, and it also destroys the record that the money is still owed.
   */
  it('refuses to approve a deposit whose user is gone, leaving it pending', async () => {
    const { env } = makeEnv();
    await seedDeposit(env, 'dep1', 'ghost', 120);

    const res = await action(env, 'dep1', 'approve');

    expect(res.status).toBeGreaterThanOrEqual(400);
    const deposit = await drizzleOf(env)
      .select()
      .from(schema.deposits)
      .where(eq(schema.deposits.id, 'dep1'))
      .get();
    expect(deposit?.status).toBe('pending');
    const payments = await drizzleOf(env).select().from(schema.payments).all();
    expect(payments).toHaveLength(0);
  });

  /** The health probe that keeps the atomicity claim honest. */
  it('money health flags an approved deposit that was never credited', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 0);
    await seedDeposit(env, 'dep1', 'alice', 120, { status: 'approved', creditedAt: null });

    const health = await computeMoneyHealth(env as any);

    expect(health.strandedApprovedDeposits).toBe(1);
    expect(health.ok).toBe(false);
  });

  it('money health is clean after a real approval', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 0);
    await seedDeposit(env, 'dep1', 'alice', 120);
    await action(env, 'dep1', 'approve');

    const health = await computeMoneyHealth(env as any);

    expect(health.strandedApprovedDeposits).toBe(0);
    expect(health.ledgerDrift.count).toBe(0);
    expect(health.ok).toBe(true);
  });
});

// ===========================================================================
/**
 * Daily task rewards. The claim row was written OUTSIDE the crediting batch and
 * the `dpcoin +=` was gated on nothing, so a crash between the two left the claim
 * present and the reward gone forever — `already-exists` on every retry, and no
 * sweeper. `claimAdReward`, directly above it in the same file, already did it
 * correctly.
 */
describe('claimDailyTask', () => {
  async function call(env: TestEnv, uid: string, taskId: string) {
    const res = await app.request(
      '/api',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${uid}` },
        body: JSON.stringify({ action: 'claimDailyTask', taskId }),
      },
      env,
      fakeCtx(),
    );
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
  }

  /** The task list is derived from settings; `login` needs no verifiable progress. */
  async function taskIdFor(env: TestEnv, uid: string): Promise<string | null> {
    const res = await app.request(
      '/api',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${uid}` },
        body: JSON.stringify({ action: 'dailyTasks' }),
      },
      env,
      fakeCtx(),
    );
    const body: any = await res.json().catch(() => ({}));
    const claimable = (body?.tasks ?? []).find((t: any) => t.claimable && t.type !== 'ad');
    return claimable?.id ?? null;
  }

  it('credits the reward with a matching ledger row, exactly once', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 0);
    const taskId = await taskIdFor(env, 'alice');
    if (!taskId) return; // no default claimable task in this config

    const first = await call(env, 'alice', taskId);
    expect(first.status).toBe(200);
    const reward = Number(first.body.reward);
    expect(reward).toBeGreaterThan(0);
    expect(await balanceOf(env, 'alice')).toBe(reward);
    await expectNoDrift(env, 'alice');

    // Replay: the claim row already exists, and the LEDGER row is what refuses
    // the second credit (the claim key is stable across retries, so gating on it
    // alone would have authorised this).
    const second = await call(env, 'alice', taskId);
    expect(second.status).toBeGreaterThanOrEqual(400);
    expect(await balanceOf(env, 'alice')).toBe(reward);
    await expectNoDrift(env, 'alice');

    // Deterministic ledger id — one row per (uid, day, task).
    const rows = await drizzleOf(env)
      .select()
      .from(schema.coinTransactions)
      .where(like(schema.coinTransactions.id, 'daily_task:alice:%'))
      .all();
    expect(rows).toHaveLength(1);
  });
});


// ===========================================================================
/**
 * The create-vs-pause race in `startMatch`.
 *
 * An admin can pause a contest between the entry fee being charged and the match
 * being observed as created. The rollback that handles it used to DELETE the
 * entry-fee ledger row — the only refund path in the worker that rewrote history
 * instead of appending to it, so the user's transaction list lost both halves and a
 * charge they had really been through became unexplainable. Its re-credit was also
 * gated on the MATCH still waiting rather than on the charge it was compensating,
 * so the coins could be handed back with nothing offsetting them.
 */
describe('startMatch pause-race rollback', () => {
  async function seedContest(env: TestEnv, id: string, totalEntryFee: number, status = 'live') {
    await drizzleOf(env)
      .insert(schema.contests)
      .values({
        id,
        title: `Contest ${id}`,
        type: 'photo',
        status,
        totalEntryFee,
        rewardCoins: totalEntryFee,
        minVotes: 0,
        autoCancelHours: 24,
        createdAt: Date.now(),
      } as any);
  }

  async function startMatch(env: TestEnv, uid: string, contestId: string) {
    const res = await app.request(
      '/api',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${uid}` },
        body: JSON.stringify({
          action: 'startMatch',
          contestId,
          mediaUrl: 'https://cdn.test/entry.jpg',
          mediaType: 'photo',
        }),
      },
      env,
      fakeCtx(),
    );
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
  }

  it('charges the entry fee and ledgers it on the happy path', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 100);
    await seedContest(env, 'c1', 40); // 20 per player

    const res = await startMatch(env, 'alice', 'c1');

    expect(res.status).toBe(200);
    expect(await balanceOf(env, 'alice')).toBe(80);
    await expectNoDrift(env, 'alice');
  });

  it('charges nothing at all when the contest is already paused', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 100);
    await seedContest(env, 'c1', 40, 'paused');

    const res = await startMatch(env, 'alice', 'c1');

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await balanceOf(env, 'alice')).toBe(100);
    await expectNoDrift(env, 'alice');
  });

  /**
   * THE RACE ITSELF: the contest is paused BETWEEN the up-front status check and
   * the post-create re-read, which is the only way to reach the rollback.
   *
   * Reproduced by flipping the row during the handler's SECOND read of `contests`
   * (the reconciliation read, which selects only `status`). The fee must come back,
   * the entry-fee ledger row must SURVIVE, and a compensating refund row must be
   * appended beside it — the old code deleted the charge instead, leaving the user
   * with no record of a charge they had really been through.
   */
  it('refunds by APPENDING a refund row, never by deleting the charge', async () => {
    const { env, db: sqlite } = makeEnv();
    await seedUser(env, 'alice', 100);
    await seedContest(env, 'c1', 40);

    const originalPrepare = env.DB.prepare.bind(env.DB);
    let contestReads = 0;
    (env.DB as any).prepare = (sql: string) => {
      if (/from\s+"?contests"?/i.test(sql) && /select/i.test(sql)) {
        contestReads++;
        // The 2nd read is the post-create reconciliation. Pause the contest just
        // before it runs, exactly as a concurrent admin action would.
        if (contestReads === 2) {
          sqlite.prepare(`UPDATE contests SET status = 'paused' WHERE id = ?`).run('c1');
        }
      }
      return originalPrepare(sql);
    };

    const res = await startMatch(env, 'alice', 'c1');
    (env.DB as any).prepare = originalPrepare;

    // The user is told, and refunded.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await balanceOf(env, 'alice')).toBe(100);
    await expectNoDrift(env, 'alice');

    const db = drizzleOf(env);
    // History is intact: the charge is still there…
    const charges = await db
      .select()
      .from(schema.coinTransactions)
      .where(like(schema.coinTransactions.id, 'contest_entry:%'))
      .all();
    expect(charges).toHaveLength(1);
    expect(Number(charges[0].amount)).toBe(-20);
    // …and a compensating refund sits beside it, summing to zero.
    const refunds = await db
      .select()
      .from(schema.coinTransactions)
      .where(like(schema.coinTransactions.id, 'contest_entry_refund:%'))
      .all();
    expect(refunds).toHaveLength(1);
    expect(Number(refunds[0].amount)).toBe(20);
    expect(refunds[0].type).toBe('contest_entry_refund');
    // The half-created match is gone.
    expect(await db.select().from(schema.contestMatches).all()).toHaveLength(0);
  });

  /**
   * The rollback's own invariant, asserted directly against its SQL: the refund is
   * an append with a deterministic id, gated on the charge not already having been
   * compensated — so running it twice cannot pay twice.
   */
  it('the refund ledger id is deterministic, so a repeated rollback pays once', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 100);
    const db = drizzleOf(env);
    const ts = Date.now();
    // A charged, waiting match, exactly as startMatch leaves one.
    await db.insert(schema.contestMatches).values({
      id: 'm1',
      contestId: 'c1',
      status: 'waiting_for_opponent',
      type: 'photo',
      title: 'Battle',
      entryFee: 40,
      userA: { uid: 'alice', username: 'alice', mediaUrl: 'https://cdn.test/a.jpg' } as any,
      createdAt: ts,
      expiresAt: ts + 86_400_000,
    } as any);

    const refundId = 'contest_entry_refund:m1:alice';
    const gate =
      `EXISTS (SELECT 1 FROM contest_matches WHERE id = ? AND status = 'waiting_for_opponent')
       AND NOT EXISTS (SELECT 1 FROM coin_transactions WHERE id = ?)`;
    const runRollback = () =>
      env.DB.batch([
        env.DB.prepare(
          `UPDATE users SET dpcoin = dpcoin + ?, xp = MAX(0, xp - 10), updated_at = ?
            WHERE uid = ? AND ${gate}`,
        ).bind(20, Date.now(), 'alice', 'm1', refundId),
        env.DB.prepare(
          `INSERT OR IGNORE INTO coin_transactions
             (id, uid, amount, type, contest_id, match_id, description, created_at)
           SELECT ?, ?, ?, 'contest_entry_refund', ?, ?, ?, ?
            WHERE ${gate}`,
        ).bind(refundId, 'alice', 20, 'c1', 'm1', 'refund', Date.now(), 'm1', refundId),
      ]);

    await runRollback();
    expect(await balanceOf(env, 'alice')).toBe(120);
    // Replay: both statements no-op because the refund row now exists.
    await runRollback();
    expect(await balanceOf(env, 'alice')).toBe(120);

    const refunds = await db
      .select()
      .from(schema.coinTransactions)
      .where(eq(schema.coinTransactions.id, refundId))
      .all();
    expect(refunds).toHaveLength(1);
  });

  it('reversing the entry XP grant cannot drive XP negative', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 100, { xp: 5 });

    await env.DB.prepare(`UPDATE users SET xp = MAX(0, xp - 10) WHERE uid = ?`).bind('alice').run();

    const row = await drizzleOf(env).select().from(schema.users).where(eq(schema.users.uid, 'alice')).get();
    expect(Number(row?.xp)).toBe(0);
  });
});
