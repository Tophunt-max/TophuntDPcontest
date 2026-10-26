/**
 * Register the offline-shell service worker (public/sw.js) on the web build.
 *
 * Production builds only: in development Metro serves unhashed bundles that must
 * never be cached. `EXPO_PUBLIC_SW=off` is the off switch: the app then removes
 * any registration of /sw.js it finds (the push worker, firebase-messaging-sw.js,
 * has its own scope and is left alone).
 */
export function swMode(env: { dev: boolean; flag: string | undefined }): 'register' | 'unregister' | 'skip' {
  if (env.flag === 'off') return 'unregister';
  return env.dev ? 'skip' : 'register';
}

export function registerServiceWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const mode = swMode({ dev: typeof __DEV__ !== 'undefined' && __DEV__, flag: process.env.EXPO_PUBLIC_SW });
  if (mode === 'skip') return;
  const run = () => {
    if (mode === 'unregister') {
      void navigator.serviceWorker
        .getRegistrations()
        .then((regs) => Promise.all(regs.filter((r) => (r.active ?? r.waiting ?? r.installing)?.scriptURL.endsWith('/sw.js')).map((r) => r.unregister())))
        .catch(() => undefined);
      return;
    }
    // After load, so installing (and precaching) never competes with first paint.
    void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((e) => console.warn('[sw] registration failed', e));
  };
  if (document.readyState === 'complete') run();
  else window.addEventListener('load', run, { once: true });
}
