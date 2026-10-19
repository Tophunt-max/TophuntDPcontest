/**
 * What App Control (admin panel) means for THIS app instance, right now.
 *
 * Pure: the guard, the screens and the banners all derive their state here, so
 * they cannot disagree. Inputs are the public config (Worker lib/appControl.ts
 * `publicAppConfig`), the clock (corrected by the server's clock), who is
 * looking, and what this device has dismissed or snoozed.
 */

export type ClientPlatform = 'web' | 'android' | 'ios';
export type FeatureKey = 'contests' | 'chat' | 'stories' | 'topups' | 'withdrawals' | 'posts';
export type AnnouncementTone = 'info' | 'warning' | 'success' | 'danger';

/** "v1.4.0-beta.2" -> [1,4,0]; mirrors the Worker's parser. */
export function parseVersion(v: unknown): number[] {
  const s = String(v ?? '').trim().replace(/^v/i, '').split(/[-+ ]/)[0];
  if (!s) return [0];
  return s.split('.').map((p) => {
    const m = p.match(/^\d+/);
    return m ? parseInt(m[0], 10) : 0;
  });
}

export function compareVersions(a: unknown, b: unknown): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** A feature is ON unless the admin explicitly switched it off. */
export function featureOn(config: any, key: FeatureKey): boolean {
  return config?.features?.[key] !== false;
}

/** Which feature a route belongs to (expo-router segments), if any. */
export function featureForRoute(segments: readonly string[]): FeatureKey | null {
  const [a, b] = segments;
  if (a === 'contest') return 'contests';
  if (a === 'messages') return 'chat';
  if (a === 'story') return 'stories';
  if (a === 'wallet' && (b === 'deposit' || b === 'store')) return 'topups';
  if (a === 'wallet' && b === 'withdraw') return 'withdrawals';
  return null;
}

/** Routes that stay reachable during maintenance (staff sign-in, legal pages). */
export function allowedDuringMaintenance(segments: readonly string[]): boolean {
  const a = segments[0];
  return a === 'maintenance' || a === 'auth' || a === 'legal';
}

/** Newer of two configs (pushed vs polled), by the server-stamped version. */
export function newerConfig<T extends { version?: number } | null | undefined>(current: T, incoming: T): T {
  if (!incoming) return current;
  if (!current) return incoming;
  return (Number(incoming.version) || 0) >= (Number(current.version) || 0) ? incoming : current;
}

export interface ControlInput {
  config: any;
  /** Server-corrected "now" (see `serverNow`). */
  nowMs: number;
  platform: ClientPlatform;
  appVersion: string;
  isStaff: boolean;
  signedIn: boolean;
  /** Staff chose "enter the app anyway" this session. */
  staffBypass: boolean;
  /** minVersion the user said "later" to (soft update), if still snoozed. */
  snoozedUpdateFor: string | null;
  dismissedAnnouncementId: string | null;
}

export interface ControlState {
  maintenance: {
    active: boolean;
    message: string;
    endsAt: number | null;
    /** Upcoming scheduled window to warn about, or null. */
    upcoming: { startAt: number; endAt: number; notice: string } | null;
    /** Staff are let through. */
    bypassed: boolean;
  };
  update: { required: 'hard' | 'soft' | null; minVersion: string; url: string; message: string };
  announcement: { visible: boolean; id: string; message: string; link: string | null; tone: AnnouncementTone };
  /** Earliest future moment the state can change on its own (for a timer), or null. */
  nextChangeAt: number | null;
}

export const UPCOMING_NOTICE_MS = 48 * 3_600_000;

/** Device clock corrected by the server clock captured with the config. */
export function serverNow(config: any, deviceNow: number = Date.now()): number {
  const skew = Number(config?._skewMs);
  return Number.isFinite(skew) ? deviceNow + skew : deviceNow;
}

const httpLink = (l: unknown): string | null => {
  const s = typeof l === 'string' ? l.trim() : '';
  return s && /^https?:\/\/\S/i.test(s) ? s : null;
};

export function resolveControl(i: ControlInput): ControlState {
  const c = i.config || {};
  const now = i.nowMs;
  const future: number[] = [];
  const at = (t: unknown) => {
    const n = Number(t);
    if (Number.isFinite(n) && n > now) future.push(n);
  };

  // ---- maintenance (manual, or the scheduled window evaluated HERE so it
  // switches at the exact minute without waiting for a fetch)
  const m = c.maintenance || {};
  const sched = m.schedule && Number(m.schedule.endAt) > Number(m.schedule.startAt) ? m.schedule : null;
  const manual = m.manual === true || (m.manual === undefined && c.maintenanceMode === true);
  const inWindow = !!sched && now >= sched.startAt && now < sched.endAt;
  const active = manual || inWindow;
  if (sched) {
    at(sched.startAt);
    at(sched.endAt);
  }
  const endsAt = inWindow ? sched.endAt : manual && Number(m.endsAt) > now ? Number(m.endsAt) : null;
  const upcoming =
    sched && !active && sched.startAt > now && sched.startAt - now <= UPCOMING_NOTICE_MS
      ? { startAt: sched.startAt, endAt: sched.endAt, notice: String(sched.notice || '') }
      : null;
  if (sched && sched.startAt - UPCOMING_NOTICE_MS > now) at(sched.startAt - UPCOMING_NOTICE_MS);

  // ---- update (never on web: the web build is always the latest)
  const u = c.update || { enabled: !!c.forceUpdate && !!c.minAppVersion, mode: 'hard', minVersion: c.minAppVersion || '' };
  const below = !!u.minVersion && compareVersions(i.appVersion, u.minVersion) < 0;
  let required: 'hard' | 'soft' | null = null;
  if (i.platform !== 'web' && u.enabled && below) {
    required = u.mode === 'soft' ? (i.snoozedUpdateFor === u.minVersion ? null : 'soft') : 'hard';
  }
  const url =
    (i.platform === 'ios' ? u.iosUrl : u.androidUrl) ||
    c.updateUrl ||
    (i.platform === 'ios' ? 'https://apps.apple.com/' : 'https://play.google.com/store/apps/details?id=in.tophunt.app');

  // ---- announcement
  const a = c.announcement || {};
  const msg = typeof a.message === 'string' ? a.message.trim() : '';
  const start = Number(a.startAt) || null;
  const end = Number(a.endAt) || null;
  if (start) at(start);
  if (end) at(end);
  const inSchedule = (!start || now >= start) && (!end || now < end);
  const audienceOk = a.audience !== 'signedIn' || i.signedIn;
  const id = String(a.id || msg);
  const tone: AnnouncementTone = ['info', 'warning', 'success', 'danger'].includes(a.tone) ? a.tone : 'info';

  return {
    maintenance: {
      active,
      message: String(m.message ?? c.maintenanceMessage ?? ''),
      endsAt,
      upcoming,
      bypassed: active && i.isStaff && i.staffBypass,
    },
    update: { required, minVersion: String(u.minVersion || ''), url, message: String(u.message || '') },
    announcement: {
      visible: !!a.enabled && !!msg && inSchedule && audienceOk && i.dismissedAnnouncementId !== id,
      id,
      message: msg,
      link: httpLink(a.link),
      tone,
    },
    nextChangeAt: future.length ? Math.min(...future) : null,
  };
}

/** "45 min", "2 ghante 10 min", "1 din 3 ghante". */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60_000));
  const d = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  const min = total % 60;
  if (d > 0) return `${d} din${h ? ` ${h} ghante` : ''}`;
  if (h > 0) return `${h} ghante${min ? ` ${min} min` : ''}`;
  return `${Math.max(1, min)} min`;
}
