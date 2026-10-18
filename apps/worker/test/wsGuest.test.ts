/**
 * Guest sockets: only live, public battles, rate-limited, one D1 lookup per
 * battle per isolate window (lib/wsGuest.ts).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeEnv, drizzleOf, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';
import { memoReset } from '../src/lib/memo';
import { authorizeGuestMatchSocket } from '../src/lib/wsGuest';

beforeEach(() => memoReset());

async function seedMatch(env: TestEnv, id: string, extra: Record<string, any> = {}) {
  const ts = Date.now();
  await drizzleOf(env).insert(schema.contestMatches).values({
    id, status: 'active', type: 'photo', userA: { uid: 'a' }, userB: { uid: 'b' }, createdAt: ts, expiresAt: ts + 86_400_000, ...extra,
  } as any);
}

describe('guest match sockets', () => {
  it('allows a live public battle', async () => {
    const { env } = makeEnv();
    await seedMatch(env, 'match-public');
    expect(await authorizeGuestMatchSocket(env as any, 'match-public', '1.2.3.4')).toEqual({ ok: true });
  });

  it('refuses invite-only, finished, missing and malformed battles', async () => {
    const { env } = makeEnv();
    await seedMatch(env, 'match-private', { isPrivate: true });
    await seedMatch(env, 'match-done', { status: 'completed' });
    for (const id of ['match-private', 'match-done', 'match-missing']) {
      expect((await authorizeGuestMatchSocket(env as any, id, '1.2.3.4')).ok, id).toBe(false);
    }
    expect(await authorizeGuestMatchSocket(env as any, '../../etc', '1.2.3.4')).toMatchObject({ ok: false, status: 400 });
    expect(await authorizeGuestMatchSocket(env as any, 'x', '1.2.3.4')).toMatchObject({ ok: false, status: 400 });
  });

  it('costs one D1 lookup per battle per isolate window, however many guests connect', async () => {
    const { env } = makeEnv();
    await seedMatch(env, 'match-hot');
    let lookups = 0;
    const prepare = env.DB.prepare.bind(env.DB);
    (env.DB as any).prepare = (sql: string) => {
      if (sql.includes('FROM contest_matches')) lookups++;
      return prepare(sql);
    };
    for (let i = 0; i < 20; i++) await authorizeGuestMatchSocket(env as any, 'match-hot', `10.0.0.${i}`);
    expect(lookups).toBe(1);
  });

  it('applies the per-IP guest limiter, and fails open if it is down', async () => {
    const { env } = makeEnv();
    await seedMatch(env, 'match-public');
    const keys: string[] = [];
    (env as any).GUEST_READ_LIMITER = { limit: async ({ key }: { key: string }) => (keys.push(key), { success: false }) };
    expect(await authorizeGuestMatchSocket(env as any, 'match-public', '9.9.9.9')).toMatchObject({ ok: false, status: 429 });
    expect(keys).toEqual(['guestws:9.9.9.9']);

    (env as any).GUEST_READ_LIMITER = { limit: async () => { throw new Error('binding down'); } };
    expect(await authorizeGuestMatchSocket(env as any, 'match-public', '9.9.9.9')).toEqual({ ok: true });
  });
});

describe('/ws channel and header hygiene', () => {
  it('accepts only an exact <kind>:<ref> channel (it names the Durable Object)', async () => {
    const { parseWsChannel } = await import('../src/lib/wsGuest');
    expect(parseWsChannel('match:abc123')).toEqual({ kind: 'match', ref: 'abc123' });
    expect(parseWsChannel('user:u1')).toEqual({ kind: 'user', ref: 'u1' });
    expect(parseWsChannel('chat:2f0e-uuid')).toEqual({ kind: 'chat', ref: '2f0e-uuid' });
    for (const bad of ['match:abc123:junk', 'match:', ':abc', 'admin:x', 'match', 'match:' + 'x'.repeat(200)]) {
      expect(parseWsChannel(bad), bad).toBeNull();
    }
  });

  it('strips every header the hub trusts, so a client cannot spoof presence or identity', async () => {
    const { trustedHubHeaders } = await import('../src/lib/wsGuest');
    const h = trustedHubHeaders(
      new Headers({
        Upgrade: 'websocket',
        'X-Presence-Uid': 'victim',
        'X-Authenticated-Uid': 'victim',
        'X-Guest-Socket': '0',
        'Sec-WebSocket-Key': 'k',
      }),
    );
    expect(h.get('X-Presence-Uid')).toBeNull();
    expect(h.get('X-Authenticated-Uid')).toBeNull();
    expect(h.get('X-Guest-Socket')).toBeNull();
    // The handshake itself is untouched.
    expect(h.get('Upgrade')).toBe('websocket');
    expect(h.get('Sec-WebSocket-Key')).toBe('k');
  });
});
