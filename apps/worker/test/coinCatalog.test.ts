/**
 * Coin packages are live: an admin add / edit / delete is pushed to every open
 * app, and the public catalog is never served from a cache.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';

const { pushes } = vi.hoisted(() => ({ pushes: [] as { channels: string[]; payload: any }[] }));
vi.mock('../src/lib/publish', async (orig) => ({
  ...(await orig<any>()),
  publish: async () => {},
  publishMany: async (_env: unknown, channels: string[], payload: any) => {
    pushes.push({ channels, payload });
  },
}));

import { makeEnv, makeApp, drizzleOf, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';
import { APP_CONFIG_SHARDS } from '../src/lib/appControl';

const app = makeApp();
beforeEach(() => {
  pushes.length = 0;
});

/** A ctx whose waitUntil work can be awaited (the push runs there). */
function ctx() {
  const work: Promise<unknown>[] = [];
  return { c: { waitUntil: (p: Promise<unknown>) => void work.push(p), passThroughOnException() {} } as any, done: () => Promise.all(work) };
}
async function admin(env: TestEnv, method: string, path: string, body?: unknown) {
  const x = ctx();
  const res = await app.request(
    `/admin${path}`,
    { method, headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': 'test-admin-secret' }, body: body === undefined ? undefined : JSON.stringify(body) },
    env,
    x.c,
  );
  await x.done();
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}
async function catalog(env: TestEnv) {
  const res = await app.request('/read/coin-packages', {}, env, ctx().c);
  return { cc: res.headers.get('cache-control'), list: (await res.json()) as any[] };
}
const lastPush = () => pushes.at(-1)!;

describe('live coin packages', () => {
  it('add, edit and delete each push the new catalog to every app shard', async () => {
    const { env } = makeEnv();
    // Buy ₹1.50/coin, payout defaults to ₹1/coin: 100 + 10 bonus costs ₹150, pays out ₹110.
    await admin(env, 'POST', '/app-settings', { coinPricing: { buyRate: 1.5 } });
    pushes.length = 0;
    const created = await admin(env, 'POST', '/coin-packages', { name: 'Starter', coins: 100, bonusCoins: 10, sortOrder: 1 });
    expect(created.status).toBe(200);
    expect(lastPush().channels).toHaveLength(APP_CONFIG_SHARDS);
    expect(lastPush().payload.type).toBe('coin-packages');
    expect(lastPush().payload.packages).toEqual([
      // Price = BASE coins × buy rate; the 10 bonus coins are free.
      { id: created.body.id, name: 'Starter', coins: 100, bonusCoins: 10, priceInr: 150, totalCoins: 110, purchasable: true, bonusLocked: false, currency: 'diamond' },
    ]);
    const v1 = lastPush().payload.version;

    await admin(env, 'PATCH', `/coin-packages/${created.body.id}`, { coins: 80 });
    expect(lastPush().payload.packages[0].priceInr).toBe(120);
    expect(lastPush().payload.version).toBeGreaterThanOrEqual(v1);

    // Deactivated packages leave the public catalog.
    await admin(env, 'PATCH', `/coin-packages/${created.body.id}`, { active: false });
    expect(lastPush().payload.packages).toEqual([]);

    await admin(env, 'DELETE', `/coin-packages/${created.body.id}`);
    expect(pushes).toHaveLength(4);
  });

  it('the public catalog reflects an edit at once and is never cached', async () => {
    const { env } = makeEnv();
    const { body } = await admin(env, 'POST', '/coin-packages', { name: 'Pro', coins: 500 });
    const before = await catalog(env);
    expect(before.cc).toMatch(/no-store/);
    expect(before.list[0].priceInr).toBe(500);
    await admin(env, 'PATCH', `/coin-packages/${body.id}`, { coins: 400 });
    expect((await catalog(env)).list[0].priceInr).toBe(400);
  });

  it('changing the buy rate re-prices every package and pushes the catalog', async () => {
    const { env } = makeEnv();
    await admin(env, 'POST', '/app-settings', { coinPricing: { buyRate: 2 }, withdrawal: { conversionRate: 0.25 } });
    await admin(env, 'POST', '/coin-packages', { name: 'Small', coins: 15, bonusCoins: 5 });
    await admin(env, 'POST', '/coin-packages', { name: 'Big', coins: 100, bonusCoins: 20, sortOrder: 1 });
    pushes.length = 0;
    await admin(env, 'POST', '/app-settings', { coinPricing: { buyRate: 0.5 } });
    const push = pushes.find((x) => x.payload.type === 'coin-packages')!;
    expect(push.payload.packages.map((p: any) => [p.name, p.priceInr, p.totalCoins])).toEqual([
      ['Small', 7.5, 20],
      ['Big', 50, 120],
    ]);
    expect((await catalog(env)).list.map((p: any) => p.priceInr)).toEqual([7.5, 50]);
    // An unchanged rate does not re-push the catalog.
    pushes.length = 0;
    await admin(env, 'POST', '/app-settings', { coinPricing: { buyRate: 0.5 } });
    expect(pushes.some((x) => x.payload.type === 'coin-packages')).toBe(false);
  });

  it('a package under ₹1 is listed but not purchasable', async () => {
    const { env } = makeEnv();
    await admin(env, 'POST', '/app-settings', { coinPricing: { buyRate: 0.05 }, withdrawal: { conversionRate: 0.01 } });
    await admin(env, 'POST', '/coin-packages', { name: 'Tiny', coins: 15, bonusCoins: 5 });
    const [p] = (await catalog(env)).list;
    expect(p).toMatchObject({ priceInr: 0.75, purchasable: false });
  });

  it('refuses a rate that would make any package pay out more than it costs, naming the safe buy rate', async () => {
    const { env } = makeEnv();
    await admin(env, 'POST', '/app-settings', { coinPricing: { buyRate: 0.2 }, withdrawal: { conversionRate: 0.1 } });
    expect((await admin(env, 'POST', '/coin-packages', { name: 'Bb', coins: 10, bonusCoins: 5 })).status).toBe(200);
    // 10 + 5 bonus at ₹0.10 payout = ₹1.50 out; the buy rate must keep ₹1.50 in: ≥ ₹0.15/coin.
    const low = await admin(env, 'POST', '/app-settings', { coinPricing: { buyRate: 0.1 } });
    expect(low.status).toBe(400);
    expect(JSON.stringify(low.body)).toContain('0.15');
    // Raising the PAYOUT rate is held to the same rule.
    expect((await admin(env, 'POST', '/app-settings', { withdrawal: { conversionRate: 0.2 } })).status).toBe(400);
    expect((await admin(env, 'POST', '/app-settings', { coinPricing: { buyRate: 0.15 } })).status).toBe(200);
  });

  it('refuses a package whose bonus would pay out more than it costs', async () => {
    const { env } = makeEnv();
    await admin(env, 'POST', '/app-settings', { coinPricing: { buyRate: 0.2 }, withdrawal: { conversionRate: 0.1 } });
    expect((await admin(env, 'POST', '/coin-packages', { name: 'Greedy', coins: 10, bonusCoins: 15 })).status).toBe(400);
    const { body } = await admin(env, 'POST', '/coin-packages', { name: 'Ok', coins: 10, bonusCoins: 10 });
    expect((await admin(env, 'PATCH', `/coin-packages/${body.id}`, { bonusCoins: 15 })).status).toBe(400);
  });

  it('with no buy rate set, a bonus package is listed but not sold', async () => {
    const { env } = makeEnv();
    await drizzleOf(env).insert(schema.settings).values({ id: 'appConfig', data: { withdrawal: { conversionRate: 0.1 } } as any, updatedAt: Date.now() } as any);
    await drizzleOf(env).insert(schema.coinPackages).values({ id: 'bb', name: 'Bb', coins: 10, bonusCoins: 5, priceInr: 10, active: true, sortOrder: 0, createdAt: 1, updatedAt: 1 } as any);
    const [p] = (await catalog(env)).list;
    expect(p).toMatchObject({ priceInr: 1, purchasable: false });
  });

  it('a rejected edit pushes nothing', async () => {
    const { env } = makeEnv();
    const { body } = await admin(env, 'POST', '/coin-packages', { coins: 100 });
    pushes.length = 0;
    const r = await admin(env, 'PATCH', `/coin-packages/${body.id}`, { priceInr: -5 });
    expect(r.status).toBe(400);
    expect(pushes).toHaveLength(0);
  });

  it('a coin value (₹ per coin) change is pushed with the app config', async () => {
    const { env } = makeEnv();
    await admin(env, 'POST', '/app-settings', { withdrawal: { conversionRate: 0.5 } });
    const p = pushes.find((x) => x.payload.type === 'config')!;
    expect(p.payload.config.withdrawal.conversionRate).toBe(0.5);
  });
});
