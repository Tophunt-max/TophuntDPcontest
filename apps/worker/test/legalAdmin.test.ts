import { describe, it, expect } from 'vitest';
import { makeEnv, makeApp, fakeCtx, type TestEnv } from './helpers/harness';

const app = makeApp();

async function adminGet(env: TestEnv, path: string) {
  const res = await app.request(
    `/admin${path}`,
    { headers: { 'X-Admin-Secret': 'test-admin-secret' } },
    env,
    fakeCtx(),
  );
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

async function adminPost(env: TestEnv, path: string, body: any) {
  const res = await app.request(
    `/admin${path}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': 'test-admin-secret' },
      body: JSON.stringify(body),
    },
    env,
    fakeCtx(),
  );
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

async function readLegal(env: TestEnv) {
  const res = await app.request('/read/legal', {}, env, fakeCtx());
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

const docByKey = (docs: any[], key: string) => docs.find((d) => d.key === key);

describe('/admin/legal — the editor sees (and edits) the effective content', () => {
  it('GET returns all four docs prefilled with the bundled default (never blank)', async () => {
    const { env } = makeEnv();
    const r = await adminGet(env, '/legal');
    expect(r.status).toBe(200);
    const keys = r.body.docs.map((d: any) => d.key).sort();
    expect(keys).toEqual(['communityGuidelines', 'privacyPolicy', 'refundPolicy', 'termsOfService']);
    for (const d of r.body.docs) {
      expect(d.isCustom).toBe(false); // no override yet -> bundled default
      expect(typeof d.content).toBe('string');
      expect(d.content.length).toBeGreaterThan(100); // real bundled text, not empty
      expect(d.label.length).toBeGreaterThan(0);
    }
    expect(typeof r.body.lastUpdated).toBe('string');
  });

  it('POST stores an override, and both the editor and the app then serve it', async () => {
    const { env } = makeEnv();
    const custom = '# Our Privacy Policy\n\nWe keep it simple. Contact {{SUPPORT_EMAIL}}.';

    const save = await adminPost(env, '/legal', { key: 'privacyPolicy', content: custom });
    expect(save.status).toBe(200);
    expect(save.body.isCustom).toBe(true);

    // Editor now shows the override (raw, tokens intact) and flags it custom.
    const g = await adminGet(env, '/legal');
    const doc = docByKey(g.body.docs, 'privacyPolicy');
    expect(doc.isCustom).toBe(true);
    expect(doc.content).toBe(custom);
    // Other docs are untouched — still bundled defaults.
    expect(docByKey(g.body.docs, 'termsOfService').isCustom).toBe(false);

    // The app's public endpoint serves it, with the token interpolated.
    const app = await readLegal(env);
    expect(app.body.legalContent.privacyPolicy).toContain('We keep it simple');
    expect(app.body.legalContent.privacyPolicy).not.toContain('{{SUPPORT_EMAIL}}');
  });

  it('POST with empty content CLEARS the override, reverting to the bundled default', async () => {
    const { env } = makeEnv();
    await adminPost(env, '/legal', { key: 'refundPolicy', content: 'custom refund text here, long enough' });
    expect(docByKey((await adminGet(env, '/legal')).body.docs, 'refundPolicy').isCustom).toBe(true);

    const reset = await adminPost(env, '/legal', { key: 'refundPolicy', content: '   ' });
    expect(reset.status).toBe(200);
    expect(reset.body.isCustom).toBe(false);

    const doc = docByKey((await adminGet(env, '/legal')).body.docs, 'refundPolicy');
    expect(doc.isCustom).toBe(false);
    expect(doc.content).not.toBe('custom refund text here, long enough'); // back to bundled
    expect(doc.content.length).toBeGreaterThan(100);
  });

  it('rejects an unknown document key', async () => {
    const { env } = makeEnv();
    const r = await adminPost(env, '/legal', { key: 'notADoc', content: 'x' });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
  });

  it('requires admin authorization', async () => {
    const { env } = makeEnv();
    const getRes = await app.request('/admin/legal', {}, env, fakeCtx());
    expect(getRes.status).toBeGreaterThanOrEqual(401);
    const postRes = await app.request(
      '/admin/legal',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"key":"privacyPolicy","content":"x"}' },
      env,
      fakeCtx(),
    );
    expect(postRes.status).toBeGreaterThanOrEqual(401);
  });
});
