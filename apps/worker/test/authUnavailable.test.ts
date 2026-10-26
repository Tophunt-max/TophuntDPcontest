/**
 * A failure to fetch Google's public keys is our outage, not a bad token. It used
 * to surface as `unauthenticated` (401), which the app treats as a rejected
 * session; it is now `unavailable` (503). A bad token is still 401.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeEnv } from './helpers/harness';
import { memoReset } from '../src/lib/memo';
import { verifyIdToken } from '../src/lib/firebaseAuth';

afterEach(() => vi.unstubAllGlobals());

describe('verifyIdToken', () => {
  it('answers unavailable when the key set cannot be fetched', async () => {
    const { env } = makeEnv();
    memoReset();
    vi.stubGlobal('fetch', async () => new Response('down', { status: 502 }));
    await expect(verifyIdToken('any.token.here', env as any)).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('still answers unauthenticated for a bad token when keys are available', async () => {
    const { env } = makeEnv();
    memoReset();
    await env.CACHE_KV.put('firebase:jwks', JSON.stringify({ keys: { keys: [] }, expiresAt: Date.now() + 3_600_000 }));
    await expect(verifyIdToken('not-a-real-token', env as any)).rejects.toMatchObject({ code: 'unauthenticated' });
  });
});
