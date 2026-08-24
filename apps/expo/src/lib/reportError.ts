import { Platform } from 'react-native';
import Constants from 'expo-constants';

type Extra = Record<string, any>;

/**
 * Crash and error reporting.
 *
 * This was a `console.error` shim, which meant the app had NO production
 * telemetry: no crash reports, no error rates, no way to know a release was
 * broken except users complaining.
 *
 * It now ships events to Sentry over its plain HTTP envelope endpoint using
 * `fetch` — no `@sentry/react-native`, no native module, no extra build step, and
 * it works identically on iOS, Android and web. The trade-off is deliberate: we
 * lose automatic native-crash capture and breadcrumbs, and in exchange this can
 * be enabled today by setting one env var, with zero risk to the native build.
 * Wiring the full SDK later is a drop-in replacement for `deliver()` below.
 *
 * Enable by setting EXPO_PUBLIC_SENTRY_DSN. Without it, this stays a local log —
 * the app must never depend on telemetry being configured.
 */

const DSN = process.env.EXPO_PUBLIC_SENTRY_DSN || '';
const ENVIRONMENT =
  process.env.EXPO_PUBLIC_ENV || (__DEV__ ? 'development' : 'production');
const RELEASE = Constants.expoConfig?.version
  ? `tophunt@${Constants.expoConfig.version}`
  : undefined;

interface ParsedDsn {
  endpoint: string;
}

/** `https://<publicKey>@<host>/<projectId>` → envelope endpoint. */
function parseDsn(dsn: string): ParsedDsn | null {
  const match = /^https:\/\/([^@]+)@([^/]+)\/(.+)$/.exec(dsn.trim());
  if (!match) return null;
  const [, publicKey, host, projectPath] = match;
  const projectId = projectPath.split('/').filter(Boolean).pop();
  if (!projectId) return null;
  return {
    endpoint: `https://${host}/api/${projectId}/envelope/?sentry_key=${publicKey}&sentry_version=7`,
  };
}

const parsed = DSN ? parseDsn(DSN) : null;

/**
 * Rate limit so a render loop cannot fire thousands of events (and burn the
 * user's data). Sentry would reject them anyway; this keeps the client polite.
 */
const MAX_EVENTS_PER_MINUTE = 12;
let windowStart = Date.now();
let sentInWindow = 0;

function allowSend(): boolean {
  const now = Date.now();
  if (now - windowStart > 60_000) {
    windowStart = now;
    sentInWindow = 0;
  }
  if (sentInWindow >= MAX_EVENTS_PER_MINUTE) return false;
  sentInWindow++;
  return true;
}

/**
 * Identical messages usually mean one broken component re-rendering, not new
 * information. Collapse repeats within a short window.
 */
const recent = new Map<string, number>();
const DEDUPE_MS = 10_000;

function isDuplicate(key: string): boolean {
  const now = Date.now();
  for (const [k, at] of recent) if (now - at > DEDUPE_MS) recent.delete(k);
  if (recent.has(key)) return true;
  recent.set(key, now);
  return false;
}

function deliver(error: Error, extra?: Extra) {
  if (!parsed) return;
  const eventId = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}${Math.random()}`)
    .replace(/-/g, '')
    .slice(0, 32);

  const event = {
    event_id: eventId,
    timestamp: Date.now() / 1000,
    platform: 'javascript',
    level: 'error',
    logger: 'app',
    environment: ENVIRONMENT,
    release: RELEASE,
    tags: {
      platform: Platform.OS,
      // The OTA update id, so an error can be traced to the exact JS bundle a
      // user is running rather than just the store version.
      updateId: (Constants as any)?.expoConfig?.updateId ?? undefined,
    },
    extra,
    exception: {
      values: [
        {
          type: error.name || 'Error',
          value: error.message || 'Unknown error',
          stacktrace: error.stack
            ? { frames: [{ function: error.stack.split('\n').slice(0, 4).join(' | ') }] }
            : undefined,
        },
      ],
    },
  };

  const body =
    JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString() }) +
    '\n' +
    JSON.stringify({ type: 'event' }) +
    '\n' +
    JSON.stringify(event);

  // Fire-and-forget. Telemetry must never throw, block a render, or surface to
  // the user.
  fetch(parsed.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-sentry-envelope' },
    body,
  }).catch(() => {
    /* delivery is best-effort */
  });
}

export function reportError(error: unknown, extra?: Extra) {
  const err =
    error instanceof Error ? error : new Error(typeof error === 'string' ? error : 'Unknown error');
  const message = err.message;

  if (__DEV__) {
    console.error('[reportError]', message, extra ?? '');
    return; // never ship noise from a dev session
  }
  console.error('[reportError]', message);

  try {
    if (!parsed) return;
    if (isDuplicate(`${err.name}:${message}`)) return;
    if (!allowSend()) return;
    deliver(err, extra);
  } catch {
    /* reporting must not create errors of its own */
  }
}

/** True when crash reporting is actually configured. Used by the debug screen. */
export function errorReportingEnabled(): boolean {
  return !!parsed;
}
