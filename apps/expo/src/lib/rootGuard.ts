/**
 * The root route guard as a small state machine, so `app/_layout.tsx`'s effect
 * can be tested end to end without a navigator or a React renderer.
 *
 * The policy lives in `routeAccess.ts` (`classifyRoute` + `guardDecision`).
 * What lives HERE is the part the pure policy could not cover: remembering
 * whether the viewer was signed in on the previous run (which is what tells
 * "just signed in on this screen" and "just signed out here" apart from a
 * cold start), building the inputs from Expo Router's state, and applying the
 * decision to the router. `_layout.tsx` creates one guard per mount and calls
 * `run` from its effect with the current snapshot.
 */
import { classifyRoute, guardDecision, routeKey, type GuardDecision } from './routeAccess';
import { onboardingRedirect, type OnboardingStatus } from './profileCompletion';
import { loginHref, pathWithQuery } from './authGate';
import { postAuthDestination } from './postAuthRedirect';

export interface GuardRouter {
  replace(to: string): void;
  back(): void;
  canGoBack(): boolean;
}

export interface GuardSnapshot {
  signedIn: boolean;
  /** Auth is still resolving: never redirect on a half-known state. */
  loading: boolean;
  segments: readonly string[];
  params: Record<string, unknown>;
  pathname: string;
  /**
   * Whether the signed-in user finished onboarding (src/lib/onboarding.ts).
   * Optional so callers without it keep the previous behaviour.
   */
  onboarding?: OnboardingStatus;
}

export function createRootGuard() {
  let wasSignedIn: boolean | undefined;
  return {
    /** Decide and apply. Returns the decision (for tests and logging). */
    run(snap: GuardSnapshot, router: GuardRouter): GuardDecision {
      if (snap.loading) return { type: 'none' };
      const justSignedIn = wasSignedIn === false && snap.signedIn;
      const justSignedOut = wasSignedIn === true && !snap.signedIn;
      wasSignedIn = snap.signedIn;
      const access = classifyRoute(snap.segments, snap.params);
      // Onboarding first: an unfinished account is kept on the signup steps on
      // every navigation, reload and Back. System screens (splash, maintenance,
      // deletion) still own their own navigation.
      if (access !== 'system') {
        const to = onboardingRedirect({
          signedIn: snap.signedIn,
          status: snap.onboarding ?? 'unknown',
          routeKey: routeKey(snap.segments),
        });
        if (to) {
          router.replace(to);
          return { type: 'redirect', to };
        }
      }
      const decision = guardDecision({
        access,
        signedIn: snap.signedIn,
        authLoading: snap.loading,
        justSignedIn,
        justSignedOut,
        currentPath: pathWithQuery(snap.pathname, snap.params, snap.segments),
        destination: postAuthDestination(snap.params.redirect as string | string[] | undefined),
        loginHref,
      });
      if (decision.type === 'redirect') router.replace(decision.to);
      else if (decision.type === 'leave-auth') {
        // Reached with Back after a gated sign-in: skip the stale login entry
        // instead of re-showing the destination on top of it.
        if (router.canGoBack()) router.back();
        else router.replace(decision.to);
      }
      return decision;
    },
  };
}
