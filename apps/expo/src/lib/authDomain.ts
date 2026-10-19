/**
 * Which `authDomain` the web Firebase SDK should use.
 *
 * Firebase's popup/redirect sign-in talks to `https://<authDomain>/__/auth/…`
 * through a hidden iframe. With the default `tophuntdpcontest.firebaseapp.com`
 * that iframe is THIRD-PARTY on tophunt.in, and browsers that partition or block
 * third-party storage (Brave shields, Safari ITP, Firefox strict mode, Chrome's
 * storage partitioning) break it — sign-in fails or `signInWithRedirect` loses
 * its result.
 *
 * Serving those paths from our own origin (public/_worker.js proxies
 * `/__/auth/*` and `/__/firebase/*` to firebaseapp.com) makes them first-party.
 * Only hosts whose `https://<host>/__/auth/handler` is registered as an OAuth
 * redirect URI may use this, so it is an explicit allow-list; every other host
 * (previews, staging, localhost) keeps the default.
 *
 * `EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN` overrides: "default" forces firebaseapp.com
 * everywhere (the kill switch), any other value is used as given.
 */
export const SAME_SITE_AUTH_HOSTS = new Set(['tophunt.in']);

export function webAuthDomain(hostname: string | null | undefined, defaultDomain: string, override?: string | null): string {
  const o = (override || '').trim();
  if (o === 'default') return defaultDomain;
  if (o) return o;
  if (hostname && SAME_SITE_AUTH_HOSTS.has(hostname)) return hostname;
  return defaultDomain;
}

/** True when sign-in runs first-party, so `signInWithRedirect` is reliable here. */
export function isSameSiteAuth(authDomain: string, hostname: string | null | undefined): boolean {
  return !!hostname && authDomain === hostname;
}
