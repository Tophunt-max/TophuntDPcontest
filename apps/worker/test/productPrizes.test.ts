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
import { validateContestInput } from '../src/lib/contestAdmin';

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

/**
 * The PATCH contract for the product prize, pinned because the admin panel builds a
 * minimal field-by-field diff and this is the one field group where that is wrong.
 *
 * `validateContestInput` validates the product as a UNIT: `prizeType: "product"`
 * makes it call `assertProductPrize` over whatever the body contains, and an absent
 * key arrives as `undefined`, which fails as blank. So a diff carrying only the one
 * field that changed is refused, naming a field the admin can see filled in. Any
 * client editing a product prize has to send all five keys together.
 */
describe('validateContestInput — a product prize is a unit on PATCH', () => {
  const FULL = {
    prizeType: 'product',
    prizeProductTitle: 'boAt Airdopes 141',
    prizeProductImageUrl: 'https://media.test/p.jpg',
    prizeProductValue: 1499,
  };

  it('accepts the whole prize set', () => {
    const values = validateContestInput({ ...FULL }, false).values;
    expect(values.prizeType).toBe('product');
    expect(values.prizeProductTitle).toBe('boAt Airdopes 141');
    // A product contest pays no coins, forced rather than merely validated.
    expect(values.rewardCoins).toBe(0);
  });

  it('refuses a partial product edit, so a diffing client MUST send all five keys', () => {
    expect(() => validateContestInput({ prizeType: 'product', prizeProductTitle: 'New name' }, false))
      .toThrow(/product image/i);
    expect(() => validateContestInput({ prizeType: 'product', prizeProductImageUrl: 'https://media.test/n.jpg' }, false))
      .toThrow(/product name/i);
    expect(() => validateContestInput({ prizeType: 'product', prizeProductValue: 99 }, false))
      .toThrow(/product name/i);
    expect(() => validateContestInput({ prizeType: 'product', prizeProductDescription: 'Black' }, false))
      .toThrow(/product name/i);
  });

  it('refuses product fields that do not say which kind of prize this is', () => {
    expect(() => validateContestInput({ prizeProductTitle: 'New name' }, false))
      .toThrow(/Include prizeType/i);
  });

  it('clears the product columns on the way back to coins', () => {
    const values = validateContestInput({ prizeType: 'coins', rewardCoins: 40, totalEntryFee: 100 }, false).values;
    expect(values.prizeProductTitle).toBeNull();
    expect(values.prizeProductImageUrl).toBeNull();
    expect(values.prizeProductValue).toBe(0);
    expect(values.prizeProductDescription).toBeNull();
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

  /**
   * The Worker half of a contract shared with the app's claim form.
   *
   * `apps/expo/src/lib/deliveryAddressForm.ts` mirrors these rules in zod so a typo is
   * caught before a round trip — worth it because `submitPrizeClaim` is rate-limited
   * 10/hour FAIL-CLOSED, so a server rejection for a typo spends part of the budget
   * the user needs to fix that typo. But a mirror that drifts is worse than none:
   * stricter than this locks somebody out of a prize they won, looser burns a slot on
   * a submit that fails anyway.
   *
   * This table is duplicated verbatim in apps/expo/test/deliveryAddressForm.test.ts.
   * The duplication is forced: each app's CI job installs only its own
   * `node_modules`, this validator reaches `hono` via lib/http.ts (which the Expo job
   * cannot resolve — it failed exactly that way once), and the Worker has no `zod`.
   * Asserting one explicit table on both sides survives that split, and states what
   * the answer is meant to be rather than only that two implementations agree.
   *
   * KEEP THE TWO TABLES IDENTICAL.
   */
  const VALID_DELIVERY = {
    recipientName: 'Asha Kumari',
    phone: '9876543210',
    addressLine1: '12 MG Road, Flat 4B',
    addressLine2: '',
    landmark: '',
    city: 'Bengaluru',
    state: 'Karnataka',
    postalCode: '560001',
    notes: '',
  };

  const DELIVERY_CASES: Array<[string, Record<string, unknown>, boolean]> = [
    ['a complete valid address', VALID_DELIVERY, true],
    ['a +91 prefixed number', { ...VALID_DELIVERY, phone: '+919876543210' }, true],
    ['a 91 prefixed number', { ...VALID_DELIVERY, phone: '919876543210' }, true],
    ['a number typed with spaces and dashes', { ...VALID_DELIVERY, phone: '98765-43210' }, true],
    ['a spaced +91 number', { ...VALID_DELIVERY, phone: '+91 98765 43210' }, true],
    ['a PIN typed with a space', { ...VALID_DELIVERY, postalCode: '560 001' }, true],
    ['extra internal whitespace', { ...VALID_DELIVERY, recipientName: ' Asha   Kumari ', city: ' Bengaluru ' }, true],
    [
      'every optional field populated',
      { ...VALID_DELIVERY, addressLine2: 'HSR Layout', landmark: 'Opp. metro', notes: 'Ring twice' },
      true,
    ],
    ['a name at the 100 limit', { ...VALID_DELIVERY, recipientName: 'a'.repeat(100) }, true],
    ['a PIN starting with 9', { ...VALID_DELIVERY, postalCode: '900001' }, true],

    ['a landline-style number', { ...VALID_DELIVERY, phone: '1234567890' }, false],
    ['a number starting below 6', { ...VALID_DELIVERY, phone: '5876543210' }, false],
    ['a 9-digit number', { ...VALID_DELIVERY, phone: '987654321' }, false],
    ['an 11-digit number', { ...VALID_DELIVERY, phone: '98765432109' }, false],
    ['a blank phone', { ...VALID_DELIVERY, phone: '' }, false],
    ['a PIN starting with 0', { ...VALID_DELIVERY, postalCode: '060001' }, false],
    ['a 5-digit PIN', { ...VALID_DELIVERY, postalCode: '56001' }, false],
    ['a 7-digit PIN', { ...VALID_DELIVERY, postalCode: '5600011' }, false],
    ['a PIN with letters', { ...VALID_DELIVERY, postalCode: '56000A' }, false],
    ['a one-character name', { ...VALID_DELIVERY, recipientName: 'A' }, false],
    ['a blank name', { ...VALID_DELIVERY, recipientName: '   ' }, false],
    ['a 3-character street address', { ...VALID_DELIVERY, addressLine1: '12A' }, false],
    ['a blank street address', { ...VALID_DELIVERY, addressLine1: '' }, false],
    ['a one-character city', { ...VALID_DELIVERY, city: 'B' }, false],
    ['a blank city', { ...VALID_DELIVERY, city: '' }, false],
    ['a one-character state', { ...VALID_DELIVERY, state: 'K' }, false],
    ['a blank state', { ...VALID_DELIVERY, state: '' }, false],
    ['an over-long name', { ...VALID_DELIVERY, recipientName: 'a'.repeat(101) }, false],
    ['an over-long street address', { ...VALID_DELIVERY, addressLine1: 'a'.repeat(201) }, false],
    ['an over-long city', { ...VALID_DELIVERY, city: 'a'.repeat(81) }, false],
    ['an over-long address line 2', { ...VALID_DELIVERY, addressLine2: 'a'.repeat(201) }, false],
    ['an over-long landmark', { ...VALID_DELIVERY, landmark: 'a'.repeat(121) }, false],
    ['over-long notes', { ...VALID_DELIVERY, notes: 'a'.repeat(501) }, false],
  ];

  it.each(DELIVERY_CASES)('shares the app form’s verdict on %s -> accepted: %s', (_label, input, accepted) => {
    let ok = true;
    try {
      parseDeliveryAddress(input);
    } catch {
      ok = false;
    }
    expect(ok).toBe(accepted);
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

// ===========================================================================
/**
 * `startMatch` must SNAPSHOT the product prize onto the match, exactly as it already
 * did for `prize_coins`.
 *
 * Migration 0042 added the four columns and `resolveMatchPrize` reads them, but the
 * only production INSERT into `contest_matches` never wrote them — so every new
 * match had `prize_type IS NULL`, which the resolver interprets as "row written
 * before 0042" and back-fills from the LIVE template at settlement time.
 *
 * That silently voided the immutability guarantee for products. A match in
 * `waiting_for_opponent` is not `active`, so the admin PATCH guard ("Cannot change
 * the prize while active matches exist") does not cover it: an admin could switch a
 * template from a phone to earphones — or to coins — and change what an
 * already-paid-for battle handed over.
 */
describe('startMatch snapshots the prize onto the match', () => {
  const startMatch = (env: TestEnv, uid: string, contestId: string) =>
    app.request(
      '/api',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${uid}` },
        body: JSON.stringify({ action: 'startMatch', contestId, mediaUrl: 'https://m.test/a.jpg', mediaType: 'photo' }),
      },
      env,
      fakeCtx(),
    );

  async function seedLiveContest(env: TestEnv, values: Record<string, any>) {
    const ts = Date.now();
    await drizzleOf(env).insert(schema.contests).values({
      id: 'c1',
      title: 'Prize Contest',
      type: 'photo',
      status: 'live',
      totalEntryFee: 100,
      rewardCoins: 0,
      voteDurationDays: 1,
      autoCancelHours: 24,
      minVotes: 0,
      createdAt: ts,
      ...values,
    } as any);
  }

  it('writes the product columns so the match is not read as a legacy row', async () => {
    const { env } = makeEnv();
    await seedUsers(env, ['alice']);
    await seedLiveContest(env, {
      prizeType: 'product',
      prizeProductTitle: 'boAt Airdopes 141',
      prizeProductImageUrl: 'https://media.test/p.jpg',
      prizeProductValue: 1499,
    });

    const res = await startMatch(env, 'alice', 'c1');
    expect(res.status).toBe(200);

    const match = await drizzleOf(env).select().from(schema.contestMatches).get();
    // Non-null prize_type is what marks this as a row carrying its own snapshot.
    expect(match?.prizeType).toBe('product');
    expect(match?.prizeProductTitle).toBe('boAt Airdopes 141');
    expect(match?.prizeProductImageUrl).toBe('https://media.test/p.jpg');
    expect(match?.prizeProductValue).toBe(1499);
  });

  it('resolves that snapshot even after the template is edited underneath it', async () => {
    const { env } = makeEnv();
    await seedUsers(env, ['alice']);
    await seedLiveContest(env, {
      prizeType: 'product',
      prizeProductTitle: 'boAt Airdopes 141',
      prizeProductImageUrl: 'https://media.test/p.jpg',
      prizeProductValue: 1499,
    });
    await startMatch(env, 'alice', 'c1');

    const db = drizzleOf(env);
    // The admin swaps the prize while the match is still waiting for an opponent.
    await db
      .update(schema.contests)
      .set({ prizeProductTitle: 'A single sticker', prizeProductValue: 5 } as any)
      .where(eq(schema.contests.id, 'c1'));

    const match = await db.select().from(schema.contestMatches).get();
    const template = await db.select().from(schema.contests).get();
    const prize = resolveMatchPrize(match as any, template as any, 0);

    expect(prize.type).toBe('product');
    expect(prize.product?.title).toBe('boAt Airdopes 141');
    expect(prize.product?.value).toBe(1499);
  });

  it('stamps a coin contest as "coins" rather than leaving it null', async () => {
    const { env } = makeEnv();
    await seedUsers(env, ['alice']);
    await seedLiveContest(env, { prizeType: 'coins', rewardCoins: 40 });

    await startMatch(env, 'alice', 'c1');

    const match = await drizzleOf(env).select().from(schema.contestMatches).get();
    // NULL has to keep meaning "written before 0042" for the resolver's degrade path
    // to be meaningful, so rows written now are never allowed to be null.
    expect(match?.prizeType).toBe('coins');
    expect(match?.prizeProductTitle).toBeNull();
    // The coin snapshot still works as before, clamped to the pot.
    expect(match?.prizeCoins).toBe(40);
  });

  it('does not copy product fields onto a coin contest', async () => {
    const { env } = makeEnv();
    await seedUsers(env, ['alice']);
    // A contest switched back to coins can still have stale product columns; the
    // match must not inherit them and then claim to owe a phone.
    await seedLiveContest(env, {
      prizeType: 'coins',
      rewardCoins: 40,
      prizeProductTitle: 'Leftover phone',
      prizeProductImageUrl: 'https://media.test/old.jpg',
    });

    await startMatch(env, 'alice', 'c1');

    const match = await drizzleOf(env).select().from(schema.contestMatches).get();
    expect(match?.prizeProductTitle).toBeNull();
    expect(match?.prizeProductImageUrl).toBeNull();
    expect(resolveMatchPrize(match as any, null, 40).type).toBe('coins');
  });
});

// Imported late so the mocks above are installed first.
import { eq } from 'drizzle-orm';
