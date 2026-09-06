/**
 * Rate limiting through the RateLimiter Durable Object.
 *
 * These exercise the CLIENT (src/lib/rateLimit.ts) — the sharding rule, the
 * fail-open/fail-closed policy when the actor is unreachable, and the consume
 * semantics the call sites were written against. The actor's own SQLite plumbing
 * and its pruning alarm need the workerd runtime, which this suite does not have;
 * see test/README.md, which states the same for VoteCounter.
 *
 * The point of the move is that `max` now means `max`. The KV implementation was a
 * read-then-write on an eventually-consistent store, so concurrent requests read
 * the same value and each wrote value+1 — a burst spent one unit of budget, and the
 * real limit drifted further above the configured one the harder it was pushed.
 * `enforces the limit exactly under concurrency` below is that guarantee.
 */
import { describe, it, expect, vi } from 'vitest';

import { makeEnv, fakeRateLimiter, type TestEnv } from './helpers/harness';
import { consumeRateLimit, rateLimit } from '../src/lib/rateLimit';
import { windowIdFor, normalizeSpec } from '../src/lib/rateLimitWindow';

describe('rate limit window arithmetic', () => {
  it('buckets by absolute windows so a key rolls over predictably', () => {
    // Shared with the actor and with the harness fake, precisely so an
    // off-by-one here cannot pass tests while failing in production.
    expect(windowIdFor(0, 60)).toBe(0);
    expect(windowIdFor(59_999, 60)).toBe(0);
    expect(windowIdFor(60_000, 60)).toBe(1);
    expect(windowIdFor(3_600_000, 3600)).toBe(1);
  });

  it('refuses to widen a window or accept a nonsense limit', () => {
    // A limiter that silently treated windowSec 0 as "no window" would divide by
    // zero and bucket everything together; a negative max would be a limit of -5.
    expect(normalizeSpec(5, 0)).toEqual({ max: 5, windowSec: 1 });
    expect(normalizeSpec(-5, 60)).toEqual({ max: 0, windowSec: 60 });
    expect(normalizeSpec(NaN, NaN)).toEqual({ max: 0, windowSec: 1 });
    expect(normalizeSpec(5.9, 60.9)).toEqual({ max: 5, windowSec: 60 });
  });
});

describe('consumeRateLimit', () => {
  it('enforces the limit exactly under concurrency', async () => {
    const { env } = makeEnv();
    // Fired together, not awaited in sequence. This is the case the KV version got
    // wrong: 10 concurrent reads all saw 0 and all wrote 1, so all 10 were allowed
    // against a limit of 3. Serialized inside the actor, exactly 3 get through.
    const verdicts = await Promise.all(
      Array.from({ length: 10 }, () => consumeRateLimit(env as any, 'vote:alice', 3, 60)),
    );
    expect(verdicts.filter(Boolean)).toHaveLength(3);
  });

  it('keeps separate budgets per key and per subject', async () => {
    const { env } = makeEnv();
    expect(await consumeRateLimit(env as any, 'like:alice', 1, 60)).toBe(true);
    expect(await consumeRateLimit(env as any, 'like:alice', 1, 60)).toBe(false);
    // Different action, same subject — its own budget.
    expect(await consumeRateLimit(env as any, 'comment:alice', 1, 60)).toBe(true);
    // Different subject — must not inherit alice's exhausted budget.
    expect(await consumeRateLimit(env as any, 'like:bob', 1, 60)).toBe(true);
  });

  it('puts every limit for one subject on ONE actor, and different subjects on different actors', async () => {
    const { env } = makeEnv();
    const seen: string[] = [];
    const inner = env.RATE_LIMITER;
    env.RATE_LIMITER = {
      ...inner,
      idFromName(name: string) {
        seen.push(name);
        return inner.idFromName(name);
      },
    } as any;

    await consumeRateLimit(env as any, 'upload:alice', 10, 3600);
    await consumeRateLimit(env as any, 'upload_day:alice', 10, 86_400);
    await consumeRateLimit(env as any, 'upload_ip:1.2.3.4', 10, 3600);
    await consumeRateLimit(env as any, 'vote:ip:1.2.3.4', 10, 60);

    // Both of alice's upload caps land on her actor, so they are enforced by one
    // serialized object and cannot disagree.
    expect(seen[0]).toBe('alice');
    expect(seen[1]).toBe('alice');
    // The IP caps are a different subject and must not contend with her — an
    // individual DO has a soft ceiling near 1,000 req/s, so this is what keeps
    // that ceiling per-subject rather than global.
    expect(seen[2]).toBe('1.2.3.4');
    expect(seen[3]).toBe('ip:1.2.3.4');
  });

  it('rolls the budget over when the window advances', async () => {
    const { env } = makeEnv();
    const base = Date.UTC(2026, 0, 1, 0, 0, 0);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(base);
      expect(await consumeRateLimit(env as any, 'msg:alice', 2, 60)).toBe(true);
      expect(await consumeRateLimit(env as any, 'msg:alice', 2, 60)).toBe(true);
      expect(await consumeRateLimit(env as any, 'msg:alice', 2, 60)).toBe(false);

      vi.setSystemTime(base + 60_000);
      expect(await consumeRateLimit(env as any, 'msg:alice', 2, 60)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a key with no subject is its own shard rather than a global bucket', async () => {
    const { env } = makeEnv();
    // No current key looks like this, but one that did must not put every caller
    // on a single actor — that would be both a hotspot and a shared budget.
    expect(await consumeRateLimit(env as any, 'globalish', 1, 60)).toBe(true);
    expect(await consumeRateLimit(env as any, 'globalish', 1, 60)).toBe(false);
    expect(await consumeRateLimit(env as any, 'other:alice', 1, 60)).toBe(true);
  });
});

describe('when the limiter is unreachable', () => {
  /** An env whose RATE_LIMITER always throws, as if the DO were unavailable. */
  function brokenEnv(): TestEnv {
    const { env } = makeEnv();
    env.RATE_LIMITER = {
      idFromName() {
        return {} as any;
      },
      get() {
        return {
          async consume() {
            throw new Error('durable object unavailable');
          },
        };
      },
    } as any;
    return env;
  }

  it('fails OPEN by default, so an outage cannot stop people using the app', async () => {
    expect(await consumeRateLimit(brokenEnv() as any, 'like:alice', 1, 60)).toBe(true);
  });

  it('fails CLOSED for money and credential guards', async () => {
    // Unchanged policy from the KV implementation: for endpoints where an
    // unlimited burst costs real money, a brief refusal beats no throttle at all.
    expect(
      await consumeRateLimit(brokenEnv() as any, 'withdraw:alice', 5, 3600, { failClosed: true }),
    ).toBe(false);
    await expect(
      rateLimit(brokenEnv() as any, 'withdraw:alice', 5, 3600, { failClosed: true }),
    ).rejects.toMatchObject({ code: 'resource-exhausted' });
  });

  it('fails CLOSED when the binding is missing entirely', async () => {
    // A deploy that lost the binding must not silently remove every protected
    // throttle. `!ns` is checked explicitly so this is a refusal, not a TypeError
    // that happens to land in the same catch.
    const { env } = makeEnv();
    delete (env as any).RATE_LIMITER;
    expect(await consumeRateLimit(env as any, 'otpsend:1.2.3.4', 5, 3600, { failClosed: true })).toBe(false);
    expect(await consumeRateLimit(env as any, 'like:alice', 5, 60)).toBe(true);
  });
});

describe('rateLimit (throwing wrapper)', () => {
  it('throws resource-exhausted once the budget is gone', async () => {
    const { env } = makeEnv();
    await rateLimit(env as any, 'report:alice', 1, 3600);
    await expect(rateLimit(env as any, 'report:alice', 1, 3600)).rejects.toMatchObject({
      code: 'resource-exhausted',
    });
  });

  it('treats a zero limit as always denied rather than always allowed', async () => {
    const { env } = makeEnv();
    // Guards the direction of the `current >= max` comparison. If that were `>`,
    // a misconfigured max of 0 would allow one request through every window.
    expect(await consumeRateLimit(env as any, 'nothing:alice', 0, 60)).toBe(false);
  });
});

describe('the harness fake mirrors the actor', () => {
  it('exposes the same consume / peek / reset surface', async () => {
    // If the actor's RPC surface grows and this fake does not, every route test
    // keeps passing while production takes the failure branch. Asserting the shape
    // here is what makes that drift visible.
    const rl = fakeRateLimiter();
    const stub = rl.get(rl.idFromName('alice'));
    expect(typeof stub.consume).toBe('function');
    expect(typeof stub.peek).toBe('function');
    expect(typeof stub.reset).toBe('function');

    expect(await stub.consume([{ key: 'a:alice', max: 1, windowSec: 60 }])).toEqual({
      allowed: true,
      deniedKey: null,
    });
    expect(await stub.peek('a:alice', 60)).toBe(1);
    expect(await stub.consume([{ key: 'a:alice', max: 1, windowSec: 60 }])).toEqual({
      allowed: false,
      deniedKey: 'a:alice',
    });
    await stub.reset('a:alice');
    expect(await stub.peek('a:alice', 60)).toBe(0);
  });

  it('consumes multiple specs in order and does not refund on a later denial', async () => {
    // The semantics the call sites were written against: they used to be separate
    // sequential awaits, so an earlier limit was already spent when a later one
    // tripped. Changing that would change which limit trips first on the paths
    // that check several.
    const rl = fakeRateLimiter();
    const stub = rl.get(rl.idFromName('alice'));
    const res = await stub.consume([
      { key: 'first:alice', max: 5, windowSec: 60 },
      { key: 'second:alice', max: 0, windowSec: 60 },
    ]);
    expect(res).toEqual({ allowed: false, deniedKey: 'second:alice' });
    expect(await stub.peek('first:alice', 60)).toBe(1);
  });
});
