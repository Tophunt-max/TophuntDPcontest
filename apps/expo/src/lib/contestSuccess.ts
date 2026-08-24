import type { Router } from 'expo-router';

/**
 * Send the user to the contest congratulations screen.
 *
 * There is a purpose-built congratulations screen at `app/contest/joined` —
 * gradient tick, "Congratulations!", a share button — and it was completely
 * orphaned: nothing in the create or join flow navigated to it. Both flows
 * instead rendered an inline `SuccessModal` titled "Battle Joined!", and on the
 * photo path that modal was gated behind an animation callback that frequently
 * never fired, so users saw no confirmation at all.
 *
 * Centralised here so the photo and video flows cannot drift apart again, and so
 * the create-vs-join wording is decided in one place.
 *
 * `replace`, not `push`: the setup form is finished with. Leaving it on the stack
 * lets a back-swipe return to a filled-in form whose entry fee has already been
 * charged, which reads as "it didn't work, try again".
 */
export function goToCongratulations(
  router: Router,
  opts: { contestName?: string | null; isJoining: boolean },
): void {
  router.replace({
    pathname: '/contest/joined',
    params: {
      contestName: opts.contestName || 'Contest',
      mode: opts.isJoining ? 'join' : 'create',
    },
  });
}
