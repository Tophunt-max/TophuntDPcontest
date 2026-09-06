/**
 * Physical product prizes (migration 0042).
 *
 * The two things that must not be wrong here:
 *
 *   1. A PRODUCT PRIZE MUST NOT MOVE COINS, and a coin prize must not create a
 *      delivery obligation. `assertPrizeFundedByPot` caps `rewardCoins` at the pot
 *      the two players funded because that column is credited straight to a wallet;
 *      a product prize sidesteps that cap by not being coins at all, so the moment
 *      the two paths bleed into each other the cap stops meaning anything.
 *
 *   2. A CLAIM IS CREATED EXACTLY ONCE, and only by the resolver that actually won
 *      the settlement race. It is inserted inside `settleWinner`'s batch under the
 *      same `settlement_id` gate as the status change, so two concurrent resolvers
 *      cannot both promise to ship a phone.
 *
 * Plus the authorisation on the claim itself: the address belongs to one person and
 * stops being editable once an operator has acted on it.
 */
import { vi, describe, it, expect } from 'vitest';

vi.mock('../src/lib/firebaseAuth', () => ({
  verifyIdToken: async (token: string) => {
    const [uid, role] = token.split(':');
    return { uid, role: role || 'user' };
  },
  bearerToken: (h?: string | null) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
}));
vi.mock('../src/lib/voteCounter', () => ({
  castVote: async () => ({ votesA: 1, votesB: 0, total: 1, alreadyVoted: false, deviceUsed: false, votingClosed: false }),
  bumpEngagement: async () => ({}),
  getLiveTally: async () => ({ votesA: 0, votesB: 0, total: 0 }),
  getViewerVote: async () => ({ hasVoted: false, votedForUid: null }),
  finalizeVotes: async () => ({ votesA: 5, votesB: 1, total: 6 }),
}));
vi.mock('../src/lib/publish', () => ({ publish: async () => {}, publishMany: async () => {} }));
vi.mock('../src/lib/email', () => ({ sendUserEmail: async () => {} }));

import { makeEnv, makeApp, fakeCtx, drizzleOf, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';
import { settleWinner } from '../src/lib/contestSettlement';
import { resolveMatchPrize, assertProductPrize, normalizePrizeType } from '../src/lib/prizes';
import { parseDeliveryAddress } from '../src/lib/deliveryAddress';

const app = makeApp();
const ADMIN = { 'Content-Type': 'application/json', 'X-Admin-Secret': 'test-admin-secret' };

const ADDRESS = {
  recipientName: 'Asha Kumari',
  phone: '9876543210',
  addressLine1: '12 MG Road, Flat 4B',
  city: 'Bengaluru',
  state: 'Karnataka',
  postalCode: '560001',
};

async function seedUsers(env: TestEnv, uids: string[]) {
  const ts = Date.now();
  for (const uid of uids) {
    await drizzleOf(env)
      .insert(schema.users)
      .values({ uid, username: uid, fullName: uid, dpcoin: 1000, createdAt: ts, updatedAt: ts } as any);
  }
}

/** An active battle with a product prize snapshotted on it. */
async function seedProductMatch(env: TestEnv, id = 'm1') {
  const ts = Date.now();
  await drizzleOf(env).insert(schema.contestMatches).values({
    id,
    status: 'active',
    type: 'photo',
    title: 'Win an earphone',
    entryFee: 40,
    joinIdA: `${id}-a`,
    joinIdB: `${id}-b`,
    userA: { uid: 'alice', username: 'alice', mediaUrl: 'a.jpg', votes: 0 },
    userB: { uid: 'bob', username: 'bob', mediaUrl: 'b.jpg', votes: 0 },
    totalVotes: 0,
    minVotesRequired: 0,
    prizeCoins: 40,
    prizeType: 'product',
    prizeProductTitle: 'Boat Airdopes 141',
    prizeProductImageUrl: 'https://media.test/product-images/2026/01/x.jpg',
    prizeProductValue: 1499,
    createdAt: ts,
    activatedAt: ts,
    expiresAt: ts + 3600_000,
  } as any);
}

describe('resolveMatchPrize', () => {
  it('prefers the match snapshot over the live template', () => {
    // The reason `prizeCoins` exists, applied to the product half: editing a
    // template must not change what a battle already in flight is worth.
    const prize = resolveMatchPrize(
      { prizeType: 'product', prizeProductTitle: 'Promised phone', prizeProductImageUrl: 'https://x/i.jpg', prizeProductValue: 9999 },
      { prizeType: 'coins' },
      500,
    );
    expect(prize.type).toBe('product');
    expect(prize.product?.title).toBe('Promised phone');
  });

  it('falls back to the template only for a pre-0042 row', () => {
    // A NULL prizeType is the marker for "written before the snapshot existed".
    const prize = resolveMatchPrize(
      { prizeType: null },
      { prizeType: 'product', prizeProductTitle: 'Earphone', prizeProductImageUrl: 'https://x/i.jpg' },
      500,
    );
    expect(prize.type).toBe('product');
    expect(prize.product?.title).toBe('Earphone');
  });

  it('pays ZERO coins for a product prize, whatever the coin column says', () => {
    const prize = resolveMatchPrize(
      { prizeType: 'product', prizeProductTitle: 'Phone', prizeProductImageUrl: 'https://x/i.jpg' },
      null,
      // A stale, non-zero coin figure. If this leaked through, a product contest
      // would pay the prize AND ship the product.
      5000,
    );
    expect(prize.coins).toBe(0);
  });

  it('degrades to coins when a product prize has lost its title', () => {
    // Losing the title means we cannot say what was won. Paying the clamped coin
    // figure leaves the winner no worse off than a coin contest; creating a claim
    // for an unnamed product would leave an operator holding a request for
    // "something".
    const prize = resolveMatchPrize({ prizeType: 'product', prizeProductTitle: null }, null, 40);
    expect(prize.type).toBe('coins');
    expect(prize.coins).toBe(40);
  });

  it('treats an unknown or missing prize type as coins', () => {
    // Fails in the safe direction: every contest predating 0042 was a coin contest,
    // and an unrecognised value must not make one owe a product nobody has.
    expect(normalizePrizeType(null)).toBe('coins');
    expect(normalizePrizeType('sweepstake')).toBe('coins');
    expect(resolveMatchPrize({ prizeType: 'nonsense' }, null, 10).type).toBe('coins');
  });
});

describe('assertProductPrize', () => {
  it('requires a name AND an image', () => {
    // The image is not optional: it is what makes a physical prize believable and it
    // is rendered on every card, so a product card with an empty image well reads as
    // a broken app rather than as a prize.
    expect(() => assertProductPrize({ title: '', imageUrl: 'https://x/i.jpg', value: 0 })).toThrow(/product name/i);
    expect(() => assertProductPrize({ title: 'Phone', imageUrl: '', value: 0 })).toThrow(/product image/i);
  });

  it('rejects a non-http image url', () => {
    expect(() => assertProductPrize({ title: 'Phone', imageUrl: 'javascript:alert(1)', value: 0 })).toThrow(/http/i);
    expect(() => assertProductPrize({ title: 'Phone', imageUrl: 'not a url', value: 0 })).toThrow(/valid URL/i);
  });

  it('normalises value and trims text', () => {
    const p = assertProductPrize({ title: '  Phone  ', imageUrl: 'https://x/i.jpg', value: '1499.7', description: '  nice  ' });
    expect(p.title).toBe('Phone');
    expect(p.value).toBe(1500);
    expect(p.description).toBe('nice');
  });
});

describe('settleWinner with a product prize', () => {
  it('creates ONE claim, moves NO coins, and still records the win', async () => {
    const { env } = makeEnv();
    await seedUsers(env, ['alice', 'bob']);
    await seedProductMatch(env);
    const db = drizzleOf(env);

    const settled = await settleWinner(env as any, {
      matchId: 'm1',
      contestId: null,
      expectedStatus: 'active',
      winnerUid: 'alice',
      loserUid: 'bob',
      rewardAmount: 0,
      description: 'Prize won: Boat Airdopes 141',
      completedAt: Date.now(),
      productPrize: { title: 'Boat Airdopes 141', imageUrl: 'https://media.test/p.jpg', value: 1499 },
    });
    expect(settled).toBe(true);

    const claims = await db.select().from(schema.prizeClaims).all();
    expect(claims).toHaveLength(1);
    expect(claims[0].id).toBe('prize_claim:m1');
    expect(claims[0].uid).toBe('alice');
    expect(claims[0].status).toBe('unclaimed');
    expect(claims[0].productTitle).toBe('Boat Airdopes 141');
    // No address yet — that is exactly what `unclaimed` means, and why the delivery
    // columns cannot be NOT NULL.
    expect(claims[0].recipientName).toBeNull();

    // The wallet is untouched: a product prize is not coins.
    const alice = await db.select().from(schema.users).where(eq(schema.users.uid, 'alice')).get();
    expect(Number(alice?.dpcoin)).toBe(1000);
    // ...but the win itself is still recorded, so stats and XP are not lost.
    expect(Number(alice?.wins)).toBe(1);
    const ledger = await db.select().from(schema.coinTransactions).all();
    expect(ledger).toHaveLength(1);
    expect(Number(ledger[0].amount)).toBe(0);
  });

  it('is exactly-once: a second settlement creates no second claim', async () => {
    const { env } = makeEnv();
    await seedUsers(env, ['alice', 'bob']);
    await seedProductMatch(env);
    const db = drizzleOf(env);

    const args = {
      matchId: 'm1',
      contestId: null,
      expectedStatus: 'active' as const,
      winnerUid: 'alice',
      loserUid: 'bob',
      rewardAmount: 0,
      description: 'Prize won',
      completedAt: Date.now(),
      productPrize: { title: 'Boat Airdopes 141', imageUrl: 'https://media.test/p.jpg', value: 1499 },
    };
    expect(await settleWinner(env as any, args)).toBe(true);
    // The second resolver's token differs, so its `gate` is false and every
    // statement in its batch — including the claim insert — is a no-op.
    expect(await settleWinner(env as any, args)).toBe(false);

    expect(await db.select().from(schema.prizeClaims).all()).toHaveLength(1);
  });

  it('creates no claim for a coin prize', async () => {
    const { env } = makeEnv();
    await seedUsers(env, ['alice', 'bob']);
    await seedProductMatch(env, 'm2');
    const db = drizzleOf(env);

    await settleWinner(env as any, {
      matchId: 'm2',
      contestId: null,
      expectedStatus: 'active',
      winnerUid: 'alice',
      loserUid: 'bob',
      rewardAmount: 40,
      description: 'Victory reward',
      completedAt: Date.now(),
    });

    expect(await db.select().from(schema.prizeClaims).all()).toHaveLength(0);
    const alice = await db.select().from(schema.users).where(eq(schema.users.uid, 'alice')).get();
    expect(Number(alice?.dpcoin)).toBe(1040);
  });
});

describe('parseDeliveryAddress', () => {
  it('requires the fields a courier actually needs', () => {
    expect(() => parseDeliveryAddress({ ...ADDRESS, phone: '12345' })).toThrow(/mobile number/i);
    expect(() => parseDeliveryAddress({ ...ADDRESS, postalCode: '0123' })).toThrow(/PIN code/i);
    expect(() => parseDeliveryAddress({ ...ADDRESS, addressLine1: 'x' })).toThrow(/street address/i);
    expect(() => parseDeliveryAddress({ ...ADDRESS, city: '' })).toThrow(/city/i);
  });

  it('collapses whitespace, because these become a shipping label', () => {
    const a = parseDeliveryAddress({ ...ADDRESS, recipientName: ' Asha   Kumari\n' });
    expect(a.recipientName).toBe('Asha Kumari');
  });

  it('strips the country code so admin screens agree on one phone format', () => {
    expect(parseDeliveryAddress({ ...ADDRESS, phone: '+919876543210' }).phone).toBe('9876543210');
  });

  it('defaults the country rather than demanding it', () => {
    expect(parseDeliveryAddress(ADDRESS).country).toBe('India');
  });
});

describe('submitPrizeClaim', () => {
  async function seedClaim(env: TestEnv, overrides: Record<string, any> = {}) {
    const ts = Date.now();
    await drizzleOf(env).insert(schema.prizeClaims).values({
      id: 'prize_claim:m1',
      matchId: 'm1',
      uid: 'alice',
      status: 'unclaimed',
      productTitle: 'Boat Airdopes 141',
      productImageUrl: 'https://media.test/p.jpg',
      productValue: 1499,
      createdAt: ts,
      updatedAt: ts,
      ...overrides,
    } as any);
  }

  const submit = (env: TestEnv, uid: string, body: any) =>
    app.request(
      '/api',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${uid}` },
        body: JSON.stringify({ action: 'submitPrizeClaim', ...body }),
      },
      env,
      fakeCtx(),
    );

  it('accepts the winner’s address and moves the claim to submitted', async () => {
    const { env } = makeEnv();
    await seedUsers(env, ['alice']);
    await seedClaim(env);

    const res = await submit(env, 'alice', { matchId: 'm1', delivery: ADDRESS });
    expect(res.status).toBe(200);

    const claim = await drizzleOf(env).select().from(schema.prizeClaims).get();
    expect(claim?.status).toBe('submitted');
    expect(claim?.recipientName).toBe('Asha Kumari');
    expect(claim?.postalCode).toBe('560001');
    expect(claim?.submittedAt).toBeTruthy();
  });

  it('refuses somebody else’s prize, and says only "not found"', async () => {
    const { env } = makeEnv();
    await seedUsers(env, ['alice', 'mallory']);
    await seedClaim(env);

    const res = await submit(env, 'mallory', { matchId: 'm1', delivery: ADDRESS });
    // Not "forbidden": telling an attacker that a claim exists but is not theirs
    // would turn this endpoint into a way to discover who won what.
    expect(res.status).toBe(404);
    const claim = await drizzleOf(env).select().from(schema.prizeClaims).get();
    expect(claim?.recipientName).toBeNull();
  });

  it('allows a correction while still submitted', async () => {
    const { env } = makeEnv();
    await seedUsers(env, ['alice']);
    await seedClaim(env, { status: 'submitted', recipientName: 'Old Name', city: 'Pune' });

    const res = await submit(env, 'alice', { matchId: 'm1', delivery: ADDRESS });
    expect(res.status).toBe(200);
    const claim = await drizzleOf(env).select().from(schema.prizeClaims).get();
    expect(claim?.recipientName).toBe('Asha Kumari');
    expect(claim?.city).toBe('Bengaluru');
  });

  it('refuses an address change once an operator has acted on it', async () => {
    const { env } = makeEnv();
    await seedUsers(env, ['alice']);
    await seedClaim(env, { status: 'shipped', recipientName: 'Asha Kumari', city: 'Bengaluru' });

    const res = await submit(env, 'alice', { matchId: 'm1', delivery: { ...ADDRESS, city: 'Chennai' } });
    // The parcel is already addressed and with a courier. A silent change here
    // would send it to the wrong place. 412 = failed-precondition.
    expect(res.status).toBe(412);
    const claim = await drizzleOf(env).select().from(schema.prizeClaims).get();
    expect(claim?.city).toBe('Bengaluru');
  });
});

describe('admin fulfilment', () => {
  async function seedSubmitted(env: TestEnv) {
    const ts = Date.now();
    await drizzleOf(env).insert(schema.prizeClaims).values({
      id: 'prize_claim:m1',
      matchId: 'm1',
      uid: 'alice',
      status: 'submitted',
      productTitle: 'Boat Airdopes 141',
      productValue: 1499,
      recipientName: 'Asha Kumari',
      phone: '9876543210',
      addressLine1: '12 MG Road',
      city: 'Bengaluru',
      state: 'Karnataka',
      postalCode: '560001',
      country: 'India',
      createdAt: ts,
      submittedAt: ts,
      updatedAt: ts,
    } as any);
  }

  const setStatus = (env: TestEnv, body: any) =>
    app.request(
      '/admin/prize-claims/prize_claim:m1/status',
      { method: 'POST', headers: ADMIN, body: JSON.stringify(body) },
      env,
      fakeCtx(),
    );

  it('keeps the full address OUT of the list view', async () => {
    const { env } = makeEnv();
    await seedUsers(env, ['alice']);
    await seedSubmitted(env);

    const res = await app.request('/admin/prize-claims', { headers: ADMIN }, env, fakeCtx());
    const rows = (await res.json()) as any[];
    expect(rows).toHaveLength(1);
    // A one-line masked summary is enough to work the queue. Shipping the whole
    // address to every operator who opens the list — and into every screenshot of
    // it — is data nobody needed to do the job.
    expect(rows[0].addressLine1).toBeUndefined();
    expect(rows[0].phone).toBeUndefined();
    expect(rows[0].deliverySummary).toContain('Bengaluru');
    expect(rows[0].deliverySummary).not.toContain('9876543210');
    expect(rows[0].hasAddress).toBe(true);
  });

  it('exposes the full address on the single-claim packing screen', async () => {
    const { env } = makeEnv();
    await seedUsers(env, ['alice']);
    await seedSubmitted(env);

    const res = await app.request('/admin/prize-claims/prize_claim:m1', { headers: ADMIN }, env, fakeCtx());
    const claim = (await res.json()) as any;
    expect(claim.addressBlock).toContain('12 MG Road');
    expect(claim.addressBlock).toContain('PIN 560001');
  });

  it('enforces the state machine', async () => {
    const { env } = makeEnv();
    await seedUsers(env, ['alice']);
    await seedSubmitted(env);

    // submitted -> delivered skips the checks that give the timestamps meaning.
    // 412 = failed-precondition, i.e. "not from this state".
    expect((await setStatus(env, { status: 'delivered' })).status).toBe(412);
    expect((await setStatus(env, { status: 'approved' })).status).toBe(200);
    // ...and `approved` is not reachable from `approved`, so a double-click cannot
    // silently re-stamp `approvedAt`.
    expect((await setStatus(env, { status: 'approved' })).status).toBe(412);
  });

  it('will not mark something shipped without a courier and tracking number', async () => {
    const { env } = makeEnv();
    await seedUsers(env, ['alice']);
    await seedSubmitted(env);
    await setStatus(env, { status: 'approved' });

    // "Shipped" is a status the winner sees and acts on; the two things that make
    // it actionable are who is carrying it and under what number. 400 =
    // invalid-argument, because the transition is legal and the payload is not.
    expect((await setStatus(env, { status: 'shipped' })).status).toBe(400);
    expect((await setStatus(env, { status: 'shipped', courier: 'Delhivery' })).status).toBe(400);

    const ok = await setStatus(env, { status: 'shipped', courier: 'Delhivery', trackingNumber: 'DL123456789' });
    expect(ok.status).toBe(200);
    const claim = await drizzleOf(env).select().from(schema.prizeClaims).get();
    expect(claim?.courier).toBe('Delhivery');
    expect(claim?.shippedAt).toBeTruthy();
  });

  it('requires a reason to cancel', async () => {
    const { env } = makeEnv();
    await seedUsers(env, ['alice']);
    await seedSubmitted(env);
    // Cancelling takes a prize away from someone who won it, so it has to say why —
    // for the winner's notification and for whoever asks about it later.
    expect((await setStatus(env, { status: 'cancelled' })).status).toBe(400);
    expect((await setStatus(env, { status: 'cancelled', adminNote: 'Out of stock; coins offered instead.' })).status).toBe(200);
  });
});

// Imported late so the mocks above are installed first.
import { eq } from 'drizzle-orm';
