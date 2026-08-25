/**
 * The Bunny encode webhook must honour the webhook secret as it is actually
 * configured — including one saved in the admin panel.
 *
 * The bug this pins: the handler read `env.BUNNY_WEBHOOK_SECRET` directly, so a
 * secret entered in the admin panel was encrypted, stored, and then ignored —
 * the endpoint stayed effectively open. It now resolves the value through the
 * credential store (`getBunnyWebhookSecret`), so a panel-managed value takes
 * effect. These tests drive the handler through that resolver.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

let webhookSecret: string | null = null;

vi.mock('../src/lib/bunny', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/bunny')>();
  return {
    ...actual,
    bunnyConfigured: async () => true,
    // Stands in for the resolved (panel-or-env) value.
    getBunnyWebhookSecret: async () => webhookSecret,
    getVideo: async () => ({ status: 4, length: 10 }),
  };
});

import { webhookRoute } from '../src/routes/webhook';
import { makeEnv, fakeCtx } from './helpers/harness';

function app() {
  const a = new Hono();
  a.route('/webhook', webhookRoute);
  return a;
}

function post(body: unknown, url = 'http://x/webhook/bunny') {
  const { env } = makeEnv();
  return app().fetch(
    new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    env,
    fakeCtx(),
  );
}

beforeEach(() => {
  webhookSecret = null;
});

describe('POST /webhook/bunny — secret enforcement', () => {
  it('rejects an unsigned call when a secret is configured (panel or env)', async () => {
    webhookSecret = 'shh-secret';
    const res = await post({ VideoGuid: 'abc' });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toBe('invalid_signature');
  });

  it('accepts the call when the secret is presented on the query string', async () => {
    webhookSecret = 'shh-secret';
    // Unknown guid → the handler acks 200 after the signature passes, which is
    // all we need to prove the secret was accepted.
    const res = await post({ VideoGuid: 'not-seeded' }, 'http://x/webhook/bunny?secret=shh-secret');
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.ok).toBe(true);
    expect(body.ignored).toBe('unknown_video');
  });

  it('accepts a Bearer token carrying the secret', async () => {
    webhookSecret = 'shh-secret';
    const { env } = makeEnv();
    const res = await app().fetch(
      new Request('http://x/webhook/bunny', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer shh-secret' },
        body: JSON.stringify({ VideoGuid: 'not-seeded' }),
      }),
      env,
      fakeCtx(),
    );
    expect(res.status).toBe(200);
  });

  it('rejects a wrong secret', async () => {
    webhookSecret = 'shh-secret';
    const res = await post({ VideoGuid: 'abc' }, 'http://x/webhook/bunny?secret=wrong');
    expect(res.status).toBe(400);
  });

  it('stays open (no signature required) when no secret is configured', async () => {
    webhookSecret = null; // nothing in panel or env
    const res = await post({ VideoGuid: 'not-seeded' });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.ok).toBe(true);
  });
});
