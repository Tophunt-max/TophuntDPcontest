/**
 * Has the signed-in user FINISHED onboarding? One answer for the whole app.
 *
 * A social or phone sign-in is a real Firebase session before any profile exists
 * (the profile is created on the last signup step, `createProfile`). The app used
 * to decide "finished" in four places, each once, right after sign-in or on cold
 * start, and with a shortcut (`signupCompleted || username`). Leaving the profile
 * form with Back therefore left a signed-in user with no profile loose in the app
 * — and a screen's `useProfile` then auto-created one with made-up defaults.
 *
 * Now:
 *  - the Worker is the authority: `users.signup_completed`, set only by
 *    createProfile/create, and every other `/api` action is refused with
 *    PROFILE_INCOMPLETE until it is;
 *  - this store mirrors it for the root guard, which keeps an unfinished user on
 *    the signup steps on EVERY navigation, reload and Back — not just once;
 *  - a PROFILE_INCOMPLETE answer from any call flips the store back, so a stale
 *    "complete" can never strand the user on a screen that cannot work.
 *
 * Kept free of React Native imports so the policy is unit-testable in Node.
 */

export type OnboardingStatus = 'unknown' | 'complete' | 'incomplete';

/** Marker the Worker puts in the error message (lib/accountStatus.ts). */
export const PROFILE_INCOMPLETE_CODE = 'PROFILE_INCOMPLETE';

/** First signup step after sign-in, where an unfinished user is sent. */
export const ONBOARDING_ROUTE = '/auth/signup/fill-profile';

/** The ONLY completeness rule: the server's flag. A username alone is not enough. */
export function isProfileComplete(row: any): boolean {
  return !!row && row.signupCompleted === true;
}

/** True for an API error that means "finish onboarding first". */
export function isProfileIncompleteError(e: unknown): boolean {
  return String((e as any)?.message || '').includes(PROFILE_INCOMPLETE_CODE);
}

type State = { uid: string | null; status: OnboardingStatus; profile: any | null };
let state: State = { uid: null, status: 'unknown', profile: null };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
let inflight: { uid: string; p: Promise<OnboardingStatus> } | null = null;

export function onboardingSnapshot(): State {
  return state;
}
export function subscribeOnboarding(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function set(next: State) {
  if (next.uid === state.uid && next.status === state.status && next.profile === state.profile) return;
  state = next;
  emit();
}

/** The status for `uid`, or 'unknown' if the store is about someone else. */
export function onboardingStatusFor(uid: string | null | undefined): OnboardingStatus {
  if (!uid) return 'unknown';
  return state.uid === uid ? state.status : 'unknown';
}

/**
 * Resolve the status for `uid` from the server (the caller's own profile read).
 * A network failure leaves it 'unknown' — never guesses "incomplete" and traps a
 * real user, never guesses "complete" and lets an unfinished one through.
 */
export function refreshOnboarding(uid: string, fetchOwnProfile: (uid: string) => Promise<any>): Promise<OnboardingStatus> {
  if (inflight && inflight.uid === uid) return inflight.p;
  const p = (async () => {
    try {
      const row = await fetchOwnProfile(uid);
      const status: OnboardingStatus = isProfileComplete(row) ? 'complete' : 'incomplete';
      if (state.uid === uid || state.uid === null || state.status === 'unknown') set({ uid, status, profile: row ?? null });
      return status;
    } catch {
      if (state.uid !== uid) set({ uid, status: 'unknown', profile: null });
      return onboardingStatusFor(uid);
    } finally {
      if (inflight?.uid === uid) inflight = null;
    }
  })();
  inflight = { uid, p };
  return p;
}

export function markOnboardingComplete(uid: string, profile?: any) {
  set({ uid, status: 'complete', profile: profile ?? (state.uid === uid ? state.profile : null) });
}
export function markOnboardingIncomplete(uid: string) {
  set({ uid, status: 'incomplete', profile: state.uid === uid ? state.profile : null });
}
/** Signed out / switched account. */
export function resetOnboarding() {
  inflight = null;
  set({ uid: null, status: 'unknown', profile: null });
}

/**
 * Root-guard policy. Pure.
 *
 * A signed-in user whose onboarding is known to be unfinished is kept on the
 * signup steps: any other route sends them to the profile form. The signup
 * steps themselves and the email-action handler stay reachable, as do the legal
 * pages (the form links to the terms). 'unknown' never redirects.
 */
export function onboardingRedirect(input: {
  signedIn: boolean;
  status: OnboardingStatus;
  /** Route key like 'auth/signup/fill-profile' (segments joined, no index). */
  routeKey: string;
}): string | null {
  if (!input.signedIn) return null;
  const k = input.routeKey.replace(/\/index$/, '');
  // A finished account has no business on the form steps (e.g. Back from the
  // congratulations screen): re-submitting them cannot do anything useful.
  if (input.status === 'complete') {
    return k === 'auth/signup/fill-profile' || k === 'auth/signup/follow-someone' ? '/home' : null;
  }
  if (input.status !== 'incomplete') return null;
  if (k.startsWith('auth/signup/') && k !== 'auth/signup') return null;
  if (k === 'auth/action' || k === 'legal' || k.startsWith('legal/')) return null;
  return ONBOARDING_ROUTE;
}

/**
 * Seed the signup draft for an unfinished user who reached onboarding without
 * going through the sign-in screen's own hand-off (reload, deep link, Back):
 * provider details from the Firebase user, plus anything already on a
 * half-created profile row. Existing draft values win.
 */
export function onboardingDraftFor(
  firebaseUser: { displayName?: string | null; email?: string | null; photoURL?: string | null; phoneNumber?: string | null; providerData?: { providerId?: string }[] } | null,
  profile: any | null,
): Record<string, any> {
  if (!firebaseUser) return {};
  const providerId = firebaseUser.providerData?.[0]?.providerId || '';
  const authProvider = providerId.includes('google')
    ? 'google'
    : providerId.includes('facebook')
      ? 'facebook'
      : providerId.includes('apple')
        ? 'apple'
        : firebaseUser.phoneNumber && !firebaseUser.email
          ? 'phone'
          : providerId === 'password'
            ? 'email'
            : 'google';
  const p = profile || {};
  return {
    authProvider,
    fullName: p.fullName || firebaseUser.displayName || '',
    email: firebaseUser.email || '',
    phone: firebaseUser.phoneNumber || '',
    avatarUrl: p.profileImageUrl || firebaseUser.photoURL || '',
    // A half-created row's auto-generated username is offered, not forced.
    username: p.username || '',
    dob: p.dob || '',
    gender: p.gender || '',
    occupation: p.occupation || '',
  };
}
