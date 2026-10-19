/**
 * The ONE route-access policy for the app (guest-first).
 *
 * Signed-out visitors can open the app straight into public content — Home,
 * Explore, contest listings, battles, public profiles, Stories, leaderboard,
 * blog and legal pages — and are only asked to sign in when they open a
 * genuinely personal screen (messages, wallet, settings, notifications…) or tap a
 * protected action (see `useAuthGate`).
 *
 * Matching is on Expo Router's resolved SEGMENTS (route file names, e.g.
 * `['story', 'view', '[userId]']`), compared exactly — never by substring, so a
 * path like `/profile-tips` can never be mistaken for `/profile`. A route that is
 * not listed is PRIVATE (fail closed): a new screen has to be made public on
 * purpose.
 *
 * UI routing is a convenience, not a security boundary. Every private screen is
 * backed by Worker endpoints that enforce authentication themselves.
 */

export type RouteAccess =
  /** Anyone, signed in or not. */
  | 'public'
  /** Requires a session; guests are sent to sign in with a return path. */
  | 'private'
  /** Sign-in/sign-up entry screens: a signed-in visitor is sent on to their destination. */
  | 'auth-entry'
  /** Reachable both ways and never bounced (Firebase action links, post-signup steps). */
  | 'auth-flow'
  /** Owns its own navigation (splash, maintenance/update/deletion gates). */
  | 'system';

const key = (segments: readonly string[]) => segments.filter((s) => s && !(s.startsWith('(') && s.endsWith(')'))).join('/');

/** Exact segment paths. Groups like `(tabs)` are ignored. */
const TABLE: Record<string, RouteAccess> = {
  // System
  '': 'system',
  index: 'system',
  splash: 'system',
  maintenance: 'system',
  'force-update': 'system',
  // App Control: where a link into a switched-off feature lands (guests too).
  'feature-off': 'system',
  'account-scheduled-deletion': 'system',

  // Public content
  home: 'public',
  explore: 'public',
  'explore/leaderboard': 'public',
  'battle/[id]': 'public',
  'battle/[id]/result': 'public', // winner page; shared result links open for guests
  blog: 'public',
  'blog/[slug]': 'public',
  '[slug]': 'public', // `/@handle` profiles and root blog permalinks
  'legal/terms': 'public',
  'legal/privacy': 'public',
  'legal/refund': 'public',
  'legal/guidelines': 'public',
  'story/view/[userId]': 'public',
  'story/highlight/[userId]': 'public',
  'contest/photo': 'public', // contest LISTING; entering is gated
  'contest/video': 'public', // listing; submitting is gated
  'profile/connections': 'public',
  'profile/wins': 'public',
  '+not-found': 'public',
  onboarding: 'auth-entry',

  // Auth
  'auth/login': 'auth-entry',
  'auth/login/password': 'auth-entry',
  'auth/login/phone': 'auth-entry',
  'auth/signup': 'auth-entry',
  'auth/forgot-password': 'auth-entry',
  'auth/forgot-password/otp': 'auth-entry',
  'auth/forgot-password/reset': 'auth-entry',
  'auth/forgot-password/success': 'auth-entry',
  'auth/action': 'auth-flow',
  'auth/signup/fill-profile': 'auth-flow',
  'auth/signup/follow-someone': 'auth-flow',
  'auth/signup/congratulations': 'auth-flow',
};

/** Route segments with an optional `index` file name removed. */
function normalise(segments: readonly string[]): readonly string[] {
  const s = [...segments];
  if (s.length > 1 && s[s.length - 1] === 'index') s.pop();
  return s;
}

/**
 * Classify the current route.
 *
 * `/profile` is the one route whose access depends on a parameter: with
 * `?userId=<someone>` it is that person's public profile; without one it is the
 * viewer's OWN profile, which needs an account.
 */
export function classifyRoute(segments: readonly string[], params: { userId?: unknown } = {}): RouteAccess {
  const k = key(normalise(segments));
  if (k === 'profile') {
    const uid = Array.isArray(params.userId) ? params.userId[0] : params.userId;
    return typeof uid === 'string' && uid.trim() ? 'public' : 'private';
  }
  return TABLE[k] ?? 'private';
}

export type GuardDecision =
  | { type: 'none' }
  | { type: 'redirect'; to: string }
  /**
   * A signed-in user is on a sign-in screen they did not just use (typically
   * reached with Back after a gated sign-in). Leave it: go back past it when
   * there is history, otherwise replace it with `to`.
   */
  | { type: 'leave-auth'; to: string };

/**
 * What the root guard should do for a route. Pure, so the whole policy is
 * testable without a navigator.
 *
 *  - while auth is still resolving: nothing (no premature redirect)
 *  - guest on a private route: sign in, then come back here — except right
 *    after signing OUT there, which lands on the public Home (guest-first, and
 *    no race with the screen's own post-sign-out navigation)
 *  - signed-in user on a sign-in/sign-up entry screen: leave it for their
 *    destination — EXCEPT right after signing in on that screen, which
 *    navigates itself (to a redirect, or to profile setup for a new account)
 *  - everything else: nothing
 */
export function guardDecision(input: {
  access: RouteAccess;
  signedIn: boolean;
  authLoading: boolean;
  /** The session started while this screen was showing. */
  justSignedIn?: boolean;
  /** The session ended while this screen was showing. */
  justSignedOut?: boolean;
  /** The current in-app path with query, for the return trip. */
  currentPath: string;
  /** Sanitised post-auth destination of the current screen, if any. */
  destination: string;
  /** Builds the sign-in href for a return path. */
  loginHref: (returnTo: string) => string;
}): GuardDecision {
  const { access, signedIn, authLoading } = input;
  if (authLoading) return { type: 'none' };
  if (!signedIn && access === 'private') {
    if (input.justSignedOut) return { type: 'redirect', to: '/home' };
    return { type: 'redirect', to: input.loginHref(input.currentPath) };
  }
  if (signedIn && access === 'auth-entry' && !input.justSignedIn) return { type: 'leave-auth', to: input.destination };
  return { type: 'none' };
}
