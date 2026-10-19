/**
 * App Control on the device (src/lib/appControl.ts): maintenance (manual and
 * scheduled, with staff bypass), force/soft update, the announcement banner,
 * feature-gated routes, and newest-config-wins.
 */
import { describe, it, expect } from 'vitest';
import {
  allowedDuringMaintenance,
  compareVersions,
  featureForRoute,
  featureOn,
  formatCountdown,
  newerConfig,
  resolveControl,
  serverNow,
  type ControlInput,
} from '@/src/lib/appControl';
import { bannerVisibleOn } from '@/src/lib/announcementBanner';

const NOW = 1_800_000_000_000;
const H = 3_600_000;
const base = (config: any, extra: Partial<ControlInput> = {}): ControlInput => ({
  config,
  nowMs: NOW,
  platform: 'android',
  appVersion: '1.5.0',
  isStaff: false,
  signedIn: true,
  staffBypass: false,
  snoozedUpdateFor: null,
  dismissedAnnouncementId: null,
  ...extra,
});

describe('maintenance', () => {
  it('manual switch, with a countdown when the admin set a back-by time', () => {
    const c = resolveControl(base({ maintenance: { manual: true, message: 'Upgrade', endsAt: NOW + H } }));
    expect(c.maintenance).toMatchObject({ active: true, message: 'Upgrade', endsAt: NOW + H, bypassed: false });
  });

  it('old servers: the legacy maintenanceMode flag still works', () => {
    expect(resolveControl(base({ maintenanceMode: true })).maintenance.active).toBe(true);
    expect(resolveControl(base({ maintenanceMode: false })).maintenance.active).toBe(false);
  });

  it('a schedule warns ahead, switches on at its start and off at its end — no fetch needed', () => {
    const cfg = { maintenance: { manual: false, schedule: { startAt: NOW + H, endAt: NOW + 2 * H, notice: 'DB upgrade' } } };
    const before = resolveControl(base(cfg));
    expect(before.maintenance.active).toBe(false);
    expect(before.maintenance.upcoming).toMatchObject({ startAt: NOW + H, notice: 'DB upgrade' });
    expect(before.nextChangeAt).toBe(NOW + H);
    const during = resolveControl(base(cfg, { nowMs: NOW + 1.5 * H }));
    expect(during.maintenance).toMatchObject({ active: true, endsAt: NOW + 2 * H, upcoming: null });
    expect(during.nextChangeAt).toBe(NOW + 2 * H);
    expect(resolveControl(base(cfg, { nowMs: NOW + 3 * H })).maintenance.active).toBe(false);
  });

  it('staff can enter anyway; nobody else can', () => {
    const cfg = { maintenance: { manual: true } };
    expect(resolveControl(base(cfg, { isStaff: true, staffBypass: true })).maintenance.bypassed).toBe(true);
    expect(resolveControl(base(cfg, { isStaff: false, staffBypass: true })).maintenance.bypassed).toBe(false);
  });

  it('sign-in and legal pages stay reachable during maintenance', () => {
    expect(allowedDuringMaintenance(['auth', 'login'])).toBe(true);
    expect(allowedDuringMaintenance(['legal', 'terms'])).toBe(true);
    expect(allowedDuringMaintenance(['home'])).toBe(false);
  });

  it('uses the server clock, not the phone clock', () => {
    expect(serverNow({ _skewMs: 60_000 }, NOW)).toBe(NOW + 60_000);
    expect(serverNow({}, NOW)).toBe(NOW);
  });
});

describe('update', () => {
  const u = (mode: 'hard' | 'soft') => ({ update: { enabled: true, mode, minVersion: '2.0.0', androidUrl: 'https://play/x', iosUrl: 'https://apps/x', message: '' } });
  it('hard blocks old native builds; never web', () => {
    expect(resolveControl(base(u('hard'))).update).toMatchObject({ required: 'hard', url: 'https://play/x' });
    expect(resolveControl(base(u('hard'), { platform: 'ios' })).update.url).toBe('https://apps/x');
    expect(resolveControl(base(u('hard'), { platform: 'web' })).update.required).toBeNull();
    expect(resolveControl(base(u('hard'), { appVersion: '2.0.1' })).update.required).toBeNull();
  });
  it('soft can be snoozed for that minimum version only', () => {
    expect(resolveControl(base(u('soft'))).update.required).toBe('soft');
    expect(resolveControl(base(u('soft'), { snoozedUpdateFor: '2.0.0' })).update.required).toBeNull();
    expect(resolveControl(base(u('soft'), { snoozedUpdateFor: '1.9.0' })).update.required).toBe('soft');
  });
  it('legacy config (forceUpdate + minAppVersion) still forces', () => {
    expect(resolveControl(base({ forceUpdate: true, minAppVersion: '2.0' })).update.required).toBe('hard');
  });
  it('versions with a leading v or a tag compare correctly', () => {
    expect(compareVersions('1.5.0', 'v2.0.0')).toBe(-1);
    expect(compareVersions('2.0.0-beta', '2.0.0')).toBe(0);
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
  });
});

describe('announcement', () => {
  const a = (extra: any = {}) => ({ announcement: { id: 'a1', enabled: true, message: 'Naya contest!', tone: 'success', ...extra } });
  it('shows until dismissed by id; a new id shows again', () => {
    expect(resolveControl(base(a())).announcement).toMatchObject({ visible: true, tone: 'success', id: 'a1' });
    expect(resolveControl(base(a(), { dismissedAnnouncementId: 'a1' })).announcement.visible).toBe(false);
    expect(resolveControl(base(a({ id: 'a2' }), { dismissedAnnouncementId: 'a1' })).announcement.visible).toBe(true);
  });
  it('honours its window and audience', () => {
    expect(resolveControl(base(a({ startAt: NOW + H }))).announcement.visible).toBe(false);
    expect(resolveControl(base(a({ endAt: NOW - 1 }))).announcement.visible).toBe(false);
    expect(resolveControl(base(a({ audience: 'signedIn' }), { signedIn: false })).announcement.visible).toBe(false);
  });
  it('only an http(s) link is tappable', () => {
    expect(resolveControl(base(a({ link: 'javascript:alert(1)' }))).announcement.link).toBeNull();
    expect(resolveControl(base(a({ link: 'https://tophunt.in/x' }))).announcement.link).toBe('https://tophunt.in/x');
  });
  it('lives on the main tab screens only', () => {
    expect(bannerVisibleOn(['home'])).toBe(true);
    expect(bannerVisibleOn(['wallet'])).toBe(true);
    expect(bannerVisibleOn(['wallet', 'withdraw'])).toBe(false);
    expect(bannerVisibleOn(['auth', 'login'])).toBe(false);
    expect(bannerVisibleOn(['maintenance'])).toBe(false);
  });
});

describe('features', () => {
  it('maps routes to their feature switch', () => {
    expect(featureForRoute(['messages', 'chat', '[id]'])).toBe('chat');
    expect(featureForRoute(['contest', 'photo'])).toBe('contests');
    expect(featureForRoute(['wallet', 'deposit'])).toBe('topups');
    expect(featureForRoute(['wallet', 'withdraw'])).toBe('withdrawals');
    expect(featureForRoute(['wallet'])).toBeNull();
    expect(featureForRoute(['home'])).toBeNull();
  });
  it('a feature is on unless explicitly off', () => {
    expect(featureOn({ features: { chat: false } }, 'chat')).toBe(false);
    expect(featureOn({}, 'chat')).toBe(true);
    expect(featureOn(null, 'chat')).toBe(true);
  });
});

describe('newest config wins', () => {
  it('a polled copy never replaces a newer pushed one', () => {
    const pushed = { version: 20, maintenanceMode: true };
    const polled = { version: 10, maintenanceMode: false };
    expect(newerConfig(pushed, polled)).toBe(pushed);
    expect(newerConfig(polled, pushed)).toBe(pushed);
    expect(newerConfig(null as any, polled)).toBe(polled);
  });
  it('formats the maintenance countdown', () => {
    expect(formatCountdown(25 * 60_000)).toBe('25 min');
    expect(formatCountdown(130 * 60_000)).toBe('2 ghante 10 min');
    expect(formatCountdown(26 * H)).toBe('1 din 2 ghante');
  });
});
