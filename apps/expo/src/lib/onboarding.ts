/**
 * First-launch intro (app/onboarding/index.tsx) — who sees it and when.
 *
 * Shown ONLY to a new guest who opened TopHunt directly:
 *  - the app icon (no launch URL), or
 *  - the site/app root `tophunt.in/` with no query string.
 *
 * Never shown:
 *  - to a signed-in user. Splash also marks it seen for them, so signing out
 *    later does not show an intro to someone who already uses the app;
 *  - when the session started from ANY link: a shared battle or profile, a
 *    blog post, a Story, a notification, or the root with tracking/referral
 *    parameters (`/?utm_…`, `/?ref=…`). The visitor came for that content.
 *    This holds for the whole session, so a later in-app trip back through
 *    splash (blog "back", a cleared maintenance gate) does not show it either;
 *  - when an admin has switched it off (`appConfig.onboardingEnabled === false`).
 *
 * "Seen" is only recorded when the intro is actually shown and left. A link
 * visitor who later opens the app directly is still new, and gets it then.
 */
export const ONBOARDING_SEEN_KEY = 'hasSeenOnboarding';

export type EntryKind = 'direct' | 'link';

/**
 * Classify how the session started from its launch URL.
 *
 * `null`/empty (app icon) is direct. Otherwise the path must be the root (or
 * the splash/index redirect targets) with no query string. Custom schemes
 * (`tophunt://`, `exp://host:port/--/`) are handled by looking only at the path
 * after the Expo `--` separator when present.
 */
export function entryKindFromUrl(url: string | null | undefined): EntryKind {
  if (!url) return 'direct';
  let path = '';
  let query = '';
  try {
    const u = new URL(url);
    path = u.pathname;
    query = u.search.replace(/^\?/, '');
    // Custom schemes put the first segment in the host: `tophunt://battle/1`.
    if (!/^https?:$/.test(u.protocol) && u.host && !u.host.includes(':') && !u.host.includes('.')) {
      path = `/${u.host}${path}`;
    }
  } catch {
    return 'link';
  }
  const expo = path.indexOf('/--/');
  if (expo >= 0) path = path.slice(expo + 3);
  else if (path.endsWith('/--')) path = '/';
  const clean = path.replace(/\/+$/, '') || '/';
  if (query) return 'link';
  return clean === '/' || clean === '/splash' || clean === '/index' ? 'direct' : 'link';
}

/** Where splash sends a guest. `seenValue` is the raw AsyncStorage value. */
export function guestStartRoute(
  seenValue: string | null | undefined,
  opts: { entry?: EntryKind; enabled?: boolean } = {},
): '/onboarding' | '/home' {
  if (seenValue === 'true') return '/home';
  if (opts.enabled === false) return '/home';
  if (opts.entry === 'link') return '/home';
  return '/onboarding';
}

// ---------------------------------------------------------------------------
// How THIS session started — decided once, as early as possible.
// ---------------------------------------------------------------------------

let sessionEntry: EntryKind | null = null;

/**
 * On web the address bar at module load IS the launch URL (before the router
 * rewrites it), so capture it right away. Native has no address bar; splash
 * resolves it from `Linking.getInitialURL()` instead.
 */
if (typeof window !== 'undefined' && typeof window.location?.href === 'string' && typeof document !== 'undefined') {
  sessionEntry = entryKindFromUrl(window.location.href);
}

/** The session's entry, resolving the native launch URL on first call. */
export async function sessionEntryKind(getInitialURL: () => Promise<string | null>): Promise<EntryKind> {
  if (sessionEntry) return sessionEntry;
  let url: string | null = null;
  try {
    url = await getInitialURL();
  } catch {
    url = null;
  }
  sessionEntry = entryKindFromUrl(url);
  return sessionEntry;
}

/** Tests only. */
export function __resetSessionEntryForTests(kind: EntryKind | null = null) {
  sessionEntry = kind;
}
