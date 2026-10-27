import { useSyncExternalStore } from "react";

/**
 * Notice when a newer admin panel has been deployed while this tab was open.
 *
 * Why: the panel is an SPA, so a tab opened before a deploy keeps running the
 * code it loaded — indefinitely, on a phone that never closes tabs. After Bunny
 * was replaced by Qencode, an open tab kept showing "Video (Bunny Stream)" and
 * its Library ID fields against a Worker that no longer had them, and nothing
 * told the admin the page was stale. (`lazyWithReload` in App.tsx only helps
 * once a chunk 404s, which a page that is already loaded never does.)
 *
 * How: every build writes `/version.json` with its build id (vite.config.ts) and
 * bakes the same id into the bundle. This compares the two.
 *
 * It never reloads on its own while you stay on a page: an admin who switches
 * apps to copy an API key and comes back must not lose what they typed. It
 * shows a banner instead, and reloads on the next in-app navigation, which
 * discards form state anyway.
 */

const CURRENT_BUILD = import.meta.env.VITE_BUILD_ID as string | undefined;
/** Never check more often than this, however often the tab regains focus. */
const MIN_CHECK_INTERVAL_MS = 60_000;
const POLL_MS = 5 * 60_000;

let stale = false;
let lastCheck = 0;
const listeners = new Set<() => void>();

function setStale() {
  if (stale) return;
  stale = true;
  for (const l of listeners) l();
}

async function check(): Promise<void> {
  if (!CURRENT_BUILD || import.meta.env.DEV || stale) return;
  if (Date.now() - lastCheck < MIN_CHECK_INTERVAL_MS) return;
  lastCheck = Date.now();
  try {
    const res = await fetch(`/version.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return;
    const body = (await res.json()) as { buildId?: unknown };
    if (typeof body.buildId === "string" && body.buildId && body.buildId !== CURRENT_BUILD) setStale();
  } catch {
    // Offline or mid-deploy: try again on the next trigger.
  }
}

/** Start watching. Returns a cleanup function. */
export function startUpdateCheck(): () => void {
  const onVisible = () => {
    if (document.visibilityState === "visible") void check();
  };
  document.addEventListener("visibilitychange", onVisible);
  const timer = window.setInterval(onVisible, POLL_MS);
  void check();
  return () => {
    document.removeEventListener("visibilitychange", onVisible);
    window.clearInterval(timer);
  };
}

/** Call on in-app navigation: a stale tab picks up the new build there. */
export function reloadIfStale(): void {
  if (stale) window.location.reload();
  else void check();
}

/** True once a newer build is live. */
export function useUpdateAvailable(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => stale,
    () => false,
  );
}
