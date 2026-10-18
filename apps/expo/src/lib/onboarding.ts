/**
 * First-launch intro (app/onboarding/index.tsx) — who sees it and when.
 *
 *  - A GUEST sees it once, on the first cold start that goes through splash.
 *    Skip, "Get started" and "Log in" all mark it seen.
 *  - A signed-in user never sees it. Splash marks it seen for them too, so
 *    signing out later does not show an intro to someone who already uses the
 *    app. (The route guard also moves a signed-in user off /onboarding.)
 *  - Shared links (/battle/<id>, /@handle…) open their screen directly and skip
 *    splash, so they skip the intro as well: the visitor came for that content.
 */
export const ONBOARDING_SEEN_KEY = 'hasSeenOnboarding';

/** Where splash sends a guest. `seenValue` is the raw AsyncStorage value. */
export function guestStartRoute(seenValue: string | null | undefined): '/onboarding' | '/home' {
  return seenValue === 'true' ? '/home' : '/onboarding';
}
