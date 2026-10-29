/**
 * One app-wide "the network just came back" signal.
 *
 * app/_layout.tsx feeds it from NetInfo (plus the browser's own online/offline
 * events on web). Subscribers refresh right away instead of waiting for their
 * own timers:
 *  - services/realtime.ts reopens sockets that are waiting out a reconnect
 *    backoff (up to 30 s) and `live()` refetches (inbox, chat, notifications);
 *  - React Query resumes paused queries through its onlineManager;
 *  - Home has its own NetInfo recovery.
 * Pure module (no react-native import) so it is unit-tested directly.
 */
type Listener = () => void;

const listeners = new Set<Listener>();
let lastOnline: boolean | null = null;

/** Report the current connectivity. Fires listeners on an offline -> online flip only. */
export function reportConnectivity(online: boolean): void {
  const cameBack = online && lastOnline === false;
  lastOnline = online;
  if (!cameBack) return;
  for (const l of [...listeners]) {
    try {
      l();
    } catch {
      /* one subscriber must not stop the others */
    }
  }
}

export function onNetworkRecovered(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only. */
export function __resetNetworkRecoveryForTests(): void {
  listeners.clear();
  lastOnline = null;
}
