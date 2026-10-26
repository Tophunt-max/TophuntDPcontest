/**
 * When to send queued offline work (the social outbox and the Story view and
 * reaction queue).
 *
 * Triggers: the network coming back (offline → online, not every NetInfo
 * event), the app returning to the foreground, the signed-in account changing,
 * and launch. Several triggers arriving together (a phone waking up fires both
 * a foreground and a reconnect) are collapsed into one run by a short debounce.
 * The story sync used to run on EVERY NetInfo "connected" event, including a
 * Wi-Fi → cellular handover with no outage.
 */

export interface TriggerSources {
  /** Subscribe to connectivity; call back with true when usable. */
  onConnectivity: (fn: (online: boolean) => void) => () => void;
  /** Subscribe to app foregrounding. */
  onForeground: (fn: () => void) => () => void;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (t: unknown) => void;
}

export const SYNC_DEBOUNCE_MS = 1_500;

export interface SyncTriggers {
  /** Ask for a run soon (debounced). */
  request: () => void;
  stop: () => void;
}

export function startSyncTriggers(run: () => Promise<unknown> | void, src: TriggerSources): SyncTriggers {
  let timer: unknown = null;
  let lastOnline: boolean | null = null;
  let stopped = false;

  const request = () => {
    if (stopped) return;
    if (timer !== null) src.clearTimer(timer);
    timer = src.setTimer(() => {
      timer = null;
      if (stopped) return;
      try {
        void Promise.resolve(run()).catch(() => undefined);
      } catch {
        /* a sync run never throws into a trigger */
      }
    }, SYNC_DEBOUNCE_MS);
  };

  const offConn = src.onConnectivity((online) => {
    const cameBack = online && lastOnline !== true;
    lastOnline = online;
    if (cameBack) request(); // the first event is the launch state: one run
  });
  const offFg = src.onForeground(request);

  return {
    request,
    stop: () => {
      stopped = true;
      if (timer !== null) src.clearTimer(timer);
      offConn();
      offFg();
    },
  };
}
