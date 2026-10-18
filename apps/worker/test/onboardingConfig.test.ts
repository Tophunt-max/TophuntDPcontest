/**
 * Admin-managed first-launch intro: `appConfig.onboarding` / `onboardingEnabled`
 * (lib/onboardingConfig.ts). Validated on save, projected on the public read.
 */
import { describe, it, expect } from 'vitest';
import { makeEnv, makeApp, fakeCtx, type TestEnv } from './helpers/harness';
import { ONBOARDING_MAX_SLIDES } from '../src/lib/onboardingConfig';
import { USER_UPLOAD_FOLDERS } from '../src/lib/r2';

const app = makeApp();
const IMG = 'https://cdn.test/onboarding/images/2026/10/a.png';

async function admin(env: TestEnv, method: string, path: string, body?: any) {
  const res = await app.request(
    `/admin${path}`,
    {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': 'test-admin-secret' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    },
    env,
    fakeCtx(),
  );
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

async function appConfig(env: TestEnv) {
  const res = await app.request('/read/app-config', {}, env, fakeCtx());
  return (await res.json()) as any;
}

describe('onboarding in app config', () => {
  it('is on by default with no custom slides (the app uses its built-in intro)', async () => {
    const { env } = makeEnv();
    const cfg = await appConfig(env);
    expect(cfg.onboardingEnabled).toBe(true);
    expect(cfg.onboarding).toEqual([]);
  });

  it('saves slides and the switch, and the app reads exactly the display fields', async () => {
    const { env } = makeEnv();
    const save = await admin(env, 'POST', '/app-settings', {
      onboardingEnabled: false,
      onboarding: [
        { title: '  Battles  ', description: 'Two\nentries\u0007 go head to head', imageUrl: IMG, extra: 'dropped' },
        { title: 'Vote', description: '', imageUrl: '' },
      ],
    });
    expect(save.status).toBe(200);
    const cfg = await appConfig(env);
    expect(cfg.onboardingEnabled).toBe(false);
    expect(cfg.onboarding).toEqual([
      { title: 'Battles', description: 'Two entries go head to head', imageUrl: IMG },
      { title: 'Vote', description: '', imageUrl: '' },
    ]);
    // An unrelated save keeps the slides (arrays are only replaced when sent).
    await admin(env, 'POST', '/app-settings', { supportEmail: 'help@tophunt.in' });
    expect((await appConfig(env)).onboarding).toHaveLength(2);
  });

  it('refuses images not uploaded through the panel, missing titles, long text and too many slides', async () => {
    const { env } = makeEnv();
    const bad = [
      [{ title: 'x', imageUrl: 'https://evil.example/a.png' }],
      [{ title: 'x', imageUrl: 'https://cdn.test/avatars/someone.png' }],
      [{ title: 'x', imageUrl: 'javascript:alert(1)' }],
      [{ title: '', description: 'no title' }],
      [{ title: 'x'.repeat(61) }],
      [{ title: 'x', description: 'y'.repeat(201) }],
      Array.from({ length: ONBOARDING_MAX_SLIDES + 1 }, (_, i) => ({ title: `s${i}` })),
      'not a list',
    ];
    for (const onboarding of bad) {
      const r = await admin(env, 'POST', '/app-settings', { onboarding });
      expect(r.status, JSON.stringify(onboarding).slice(0, 60)).toBe(400);
    }
    expect((await admin(env, 'POST', '/app-settings', { onboardingEnabled: 'no' })).status).toBe(400);
    expect((await appConfig(env)).onboarding).toEqual([]);
  });

  it('keeps onboarding images out of the user upload folders', () => {
    expect(USER_UPLOAD_FOLDERS).not.toContain('onboarding');
  });
});
