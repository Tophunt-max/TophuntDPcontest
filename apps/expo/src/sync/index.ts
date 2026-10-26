import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';

import { drainOutbox, loadOutboxMirror, pruneOutbox } from './outbox';
import { startSyncTriggers, type SyncTriggers } from './syncTriggers';
import { trackUsage } from '@/src/lib/usageStats';

/**
 * Everything that sends queued offline work, run together. Each step is
 * independent and never throws.
 */
export async function runOfflineSync(): Promise<void> {
  await Promise.all([
    drainOutbox()
      .then((r) => {
        // Usage statistics: how much queued offline work goes through.
        if (r.sent) trackUsage('sync', 'sent', { count: r.sent });
        if (r.deferred) trackUsage('sync', 'retry', { count: r.deferred });
        if (r.failed) trackUsage('sync', 'failed', { count: r.failed });
      })
      .catch(() => undefined),
    import('@/src/services/stories/storyService')
      .then(({ syncStories }) => syncStories())
      .catch(() => undefined),
  ]);
}

let triggers: SyncTriggers | null = null;

/** Start the app-wide triggers once. Returns a stop function. */
export function startOfflineSync(): () => void {
  if (triggers) return () => undefined;
  void pruneOutbox();
  triggers = startSyncTriggers(runOfflineSync, {
    onConnectivity: (fn) =>
      NetInfo.addEventListener((s) => fn(s.isConnected !== false && s.isInternetReachable !== false)),
    onForeground: (fn) => {
      const sub = AppState.addEventListener('change', (st) => {
        if (st === 'active') fn();
      });
      return () => sub.remove();
    },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  });
  const t = triggers;
  return () => {
    t.stop();
    if (triggers === t) triggers = null;
  };
}

/** The signed-in account changed: show its pending intents, then send them. */
export function onAccountChangedForSync(): void {
  void loadOutboxMirror().then(() => triggers?.request());
}

export { enqueueOutbox, pendingIntent, subscribeOutbox, outboxSummary } from './outbox';
export { isNetworkFailure } from './failure';
