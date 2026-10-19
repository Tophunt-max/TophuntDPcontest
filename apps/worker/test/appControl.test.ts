/**
 * App Control (lib/appControl.ts): maintenance (manual + scheduled), force
 * update, announcement, feature flags and withdrawal rules — what the app is
 * told, what an admin may save, the realtime push on save, and the server gate.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../src/lib/firebaseAuth', () => ({
  verifyIdToken: async (token: string) => {
    const [uid, role] = token.split(':');
    return { uid, role: role || 'user', authTime: Math.floor(Date.now() / 1000) };
  },
  bearerToken: (h?: string | null) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
}));
const { pushes } = vi.hoisted(() => ({ pushes: [] as { channels: string[]; payload: any }[] }));
vi.mock('../src/lib/publish', async (orig) => ({
  ...(await orig<any>()),
  publish: async () => {},
  publishMany: async (_env: unknown, channels: string[], payload: any) => {
    pushes.push({ channels, payload });
  },
}));

import { makeEnv, makeApp, fakeCtx, drizzleOf, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';
import { memoReset } from '../src/lib/memo';
import {
  APP_CONFIG_SHARDS,
  appControlGate,
  compareVersions,
  featureForAction,
  publicAppConfig,
  resolveMaintenance,
  validateAppControlPatch,
} from '../src/lib/appControl';
import { parseWsChannel } from '../src/lib/wsGuest';

const app = makeApp();
beforeEach(() => {
  pushes.length = 0;
  memoReset();
});

const H = 3_600_000;
async function admin(env: TestEnv, body: unknown) {
  const res = await app.request(
    '/admin/app-settings',
    { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': 'test-admin-secret' }, body: JSON.stringify(body) },
    env,
    fakeCtx(),
  );
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}
async function api(env: TestEnv, token: string, action: string, headers: Record<string, string> = {}) {
  const res = await app.request(
    '/api',
    { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify({ action }) },
    env,
    fakeCtx(),
  );
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}
async function seedUser(env: TestEnv, uid: string) {
  const ts = Date.now();
  await drizzleOf(env).insert(schema.users).values({ uid, username: uid, fullName: uid, status: 'active', dpcoin: 0, createdAt: ts, updatedAt: ts } as any);
}

describe('versions', () => {
  it('compares like people write versions', () => {
    expect(compareVersions('1.4.0', '1.10.0')).toBe(-1);
    expect(compareVersions('v1.4.0', '1.4')).toBe(0);
    expect(compareVersions('1.4.0-beta.2', '1.4.0')).toBe(0);
    expect(compareVersions('2.0', '1.9.9')).toBe(1);
  });
});

describe('maintenance state', () => {
  const now = 1_800_000_000_000;
  it('manual switch, with an optional "back by" time', () => {
    expect(resolveMaintenance({ maintenanceMode: true, maintenanceEta: now + H }, now)).toMatchObject({ active: true, manual: true, endsAt: now + H });
    expect(resolveMaintenance({ maintenanceMode: false }, now).active).toBe(false);
  });
  it('scheduled window turns itself on and off', () => {
    const cfg = { maintenanceSchedule: { startAt: now + H, endAt: now + 2 * H, notice: 'Upgrade' } };
    expect(resolveMaintenance(cfg, now)).toMatchObject({ active: false, schedule: { startAt: now + H } });
    expect(resolveMaintenance(cfg, now + 1.5 * H)).toMatchObject({ active: true, endsAt: now + 2 * H });
    expect(resolveMaintenance(cfg, now + 3 * H)).toMatchObject({ active: false, schedule: null });
  });
});

describe('publicAppConfig', () => {
  it('a soft update is never forced on old builds; legacy fields stay', () => {
    const soft = publicAppConfig({ forceUpdate: true, forceUpdateMode: 'soft', minAppVersion: '2.0.0' });
    expect(soft.forceUpdate).toBe(false);
    expect(soft.update).toMatchObject({ enabled: true, mode: 'soft', minVersion: '2.0.0' });
    expect(publicAppConfig({ forceUpdate: true, minAppVersion: '2.0.0' }).forceUpdate).toBe(true);
  });
  it('a scheduled window reports maintenanceMode to old builds, and features are booleans', () => {
    const now = Date.now();
    const cfg = publicAppConfig({ maintenanceSchedule: { startAt: now - 1000, endAt: now + H }, features: { chat: false } }, now);
    expect(cfg.maintenanceMode).toBe(true);
    expect(cfg.features).toMatchObject({ chat: false, contests: true, posts: true });
    expect(cfg.announcement.id).toBeTruthy();
  });
});

describe('validateAppControlPatch', () => {
  const v = (body: any, existing: any = {}) => () => validateAppControlPatch(body, existing);
  it('rejects what would break the app', () => {
    expect(v({ maintenanceMode: 'true' })).toThrow(/true or false/);
    expect(v({ minAppVersion: 'latest' })).toThrow(/1\.4\.0/);
    expect(v({ forceUpdate: true })).toThrow(/minimum version/);
    expect(v({ updateUrls: { android: 'http://x' } })).toThrow(/https/);
    expect(v({ features: { chats: false } })).toThrow(/Unknown feature/);
    expect(v({ withdrawal: { conversionRate: 0 } })).toThrow(/more than 0/);
    expect(v({ withdrawal: { minAmount: 500, maxAmount: 100 } })).toThrow(/cannot be more/);
    expect(v({ withdrawal: { minAmount: '' } })).toThrow(/whole number/);
    expect(v({ announcement: { enabled: true, message: '  ' } })).toThrow(/needs a message/);
    const now = Date.now();
    expect(v({ maintenanceSchedule: { startAt: now + 2 * H, endAt: now + H } })).toThrow(/after its start/);
    expect(v({ maintenanceSchedule: { startAt: now - 3 * H, endAt: now - H } })).toThrow(/past/);
  });
  it('a changed announcement gets a new id, an unchanged one keeps it', () => {
    const a1 = { announcement: { message: 'Hello' } };
    validateAppControlPatch(a1, { announcement: { id: 'old', message: 'Hi' } });
    expect((a1.announcement as any).id).not.toBe('old');
    const a2: any = { announcement: { enabled: false } };
    validateAppControlPatch(a2, { announcement: { id: 'old', message: 'Hi' } });
    expect(a2.announcement.id).toBeUndefined();
    const a3: any = { announcement: { republish: true } };
    validateAppControlPatch(a3, { announcement: { id: 'old', message: 'Hi' } });
    expect(a3.announcement.id).toBeTruthy();
    expect(a3.announcement.republish).toBeUndefined();
  });
});

describe('admin save -> app, instantly', () => {
  it('bumps the version, pushes the public config to every shard, and audits only real changes', async () => {
    const { env } = makeEnv();
    const r1 = await admin(env, { maintenanceMode: true, maintenanceMessage: 'Back soon' });
    expect(r1.status).toBe(200);
    expect(pushes).toHaveLength(1);
    expect(pushes[0].channels).toHaveLength(APP_CONFIG_SHARDS);
    expect(pushes[0].payload.type).toBe('config');
    expect(pushes[0].payload.config).toMatchObject({ maintenanceMode: true, maintenanceMessage: 'Back soon' });
    const v1 = pushes[0].payload.config.version;
    expect(v1).toBeGreaterThan(0);

    // Re-saving the same values: newer version, but no audit row.
    const before = await env.DB.prepare("SELECT COUNT(*) n FROM admin_audit_log WHERE action LIKE 'settings.maintenance%'").first<any>();
    await admin(env, { maintenanceMode: true, maintenanceMessage: 'Back soon' });
    const after = await env.DB.prepare("SELECT COUNT(*) n FROM admin_audit_log WHERE action LIKE 'settings.maintenance%'").first<any>();
    expect(Number(after.n)).toBe(Number(before.n));
    expect(pushes[1].payload.config.version).toBeGreaterThan(v1);
  });

  it('the app-config endpoint is never cached by browsers or phones', async () => {
    const { env } = makeEnv();
    const res = await app.request('/read/app-config', {}, env, fakeCtx());
    expect(res.headers.get('cache-control')).toMatch(/no-store/);
    const body = (await res.json()) as any;
    expect(body.version).toBeTypeOf('number');
    expect(body.maintenance).toBeTruthy();
  });

  it('rejects an invalid save without pushing anything', async () => {
    const { env } = makeEnv();
    expect((await admin(env, { withdrawal: { conversionRate: -1 } })).status).toBe(400);
    expect(pushes).toHaveLength(0);
  });
});

describe('server gate', () => {
  it('maintenance closes /api writes, keeps housekeeping open, lets staff through', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'u1');
    await seedUser(env, 'boss');
    await admin(env, { maintenanceMode: true, maintenanceMessage: 'Upgrade chal raha hai' });
    memoReset();
    const r = await api(env, 'u1', 'claimDailyReward');
    expect(r.status).toBe(503);
    expect(r.body.error.reason).toBe('maintenance');
    expect(r.body.error.message).toBe('Upgrade chal raha hai');
    expect((await api(env, 'u1', 'accountDeletionStatus')).status).not.toBe(503);
    expect((await api(env, 'boss:admin', 'claimDailyReward')).status).not.toBe(503);
    // Off again: open.
    await admin(env, { maintenanceMode: false });
    memoReset();
    expect((await api(env, 'u1', 'claimDailyReward')).status).not.toBe(503);
  });

  it('a switched-off feature refuses its actions on the server too', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'u1');
    await admin(env, { features: { chat: false } });
    memoReset();
    const r = await api(env, 'u1', 'sendMessage');
    expect(r.status).toBe(412);
    expect(r.body.error.reason).toBe('feature_disabled');
    expect(featureForAction('requestWithdrawal')).toBe('withdrawals');
  });

  it('a hard update refuses old NATIVE builds only', () => {
    const cfg = { forceUpdate: true, minAppVersion: '2.0.0' };
    expect(() => appControlGate(cfg, { action: 'x', platform: 'android', appVersion: '1.9.0' })).toThrow(/update/);
    expect(() => appControlGate(cfg, { action: 'x', platform: 'android', appVersion: '2.0.1' })).not.toThrow();
    // Web is always current; builds that send no version are not guessed at.
    expect(() => appControlGate(cfg, { action: 'x', platform: 'web', appVersion: '1.0.0' })).not.toThrow();
    expect(() => appControlGate(cfg, { action: 'x' })).not.toThrow();
    // Soft never refuses.
    expect(() => appControlGate({ ...cfg, forceUpdateMode: 'soft' }, { action: 'x', platform: 'ios', appVersion: '1.0' })).not.toThrow();
  });

  it('a scheduled window closes writes at its start', () => {
    const now = Date.now();
    const cfg = { maintenanceSchedule: { startAt: now + H, endAt: now + 2 * H } };
    expect(() => appControlGate(cfg, { action: 'createPost' }, now)).not.toThrow();
    expect(() => appControlGate(cfg, { action: 'createPost' }, now + 1.5 * H)).toThrow();
  });
});

describe('realtime channel', () => {
  it('accepts exactly app:cfg0..cfg15', () => {
    expect(parseWsChannel('app:cfg0')).toEqual({ kind: 'app', ref: 'cfg0' });
    expect(parseWsChannel('app:cfg15')).toBeTruthy();
    expect(parseWsChannel('app:cfg16')).toBeNull();
    expect(parseWsChannel('app:other')).toBeNull();
  });
  it('a guest can open an app-config socket without a token', async () => {
    const { env } = makeEnv();
    const res = await app.request('/ws?channel=app:cfg3', { headers: { Upgrade: 'websocket' } }, env, fakeCtx());
    // The test harness has no real DO upgrade; anything but a 4xx refusal means it was admitted.
    expect([400, 401, 403]).not.toContain(res.status);
  });
});
