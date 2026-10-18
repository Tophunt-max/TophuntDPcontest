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
  opts: {
    contestName?: string | null;
    isJoining: boolean;
    /**
     * The match just created/joined. Threaded through so the congratulations
     * screen's Share button can build a real, openable battle link
     * (`/battle/<id>`) — without it the share had only a caption, no link.
     */
    matchId?: string | null;
    /**
     * IGNORED. A battle is never shared as one participant's photo; the share
     * image is the server-rendered VS card resolved by match id. Kept only so
     * existing call sites compile; it is not forwarded.
     */
    imageUrl?: string | null;
  },
): void {
  router.replace({
    pathname: '/contest/joined',
    params: {
      contestName: opts.contestName || 'Contest',
      mode: opts.isJoining ? 'join' : 'create',
      // Only include when present — expo-router serialises every param into the
      // URL, and empty values would add noise like `?matchId=`.
      ...(opts.matchId ? { matchId: opts.matchId } : {}),
    },
  });
}

/**
 * Server-confirmed VS Story state, as returned by the Worker's
 * `getMatchStoryStatus` action (and `vsStoryStatus` on match reads).
 */
export type VsStoryState = 'waiting_for_opponent' | 'preparing' | 'live' | 'failed' | 'unavailable';

export interface ContestSuccessCopy {
  title: string;
  subtitle: string;
  info: string;
  /** Whether the screen should keep polling the server for a newer state. */
  poll: boolean;
  /** Whether to offer a manual "Check again" (only ever re-reads; never re-submits). */
  canRefresh: boolean;
}

/**
 * What the congratulations screen may claim, decided ONLY by what the server has
 * confirmed. In particular "Your VS Story is now live" is shown only for `live`,
 * which the Worker reports only after BOTH participants' Story rows exist.
 *
 * `status` is null before the first server answer arrives.
 */
export function contestSuccessCopy(mode: 'create' | 'join', status: VsStoryState | null): ContestSuccessCopy {
  if (mode === 'create' || status === 'waiting_for_opponent') {
    return {
      title: 'Entry submitted',
      subtitle: 'Entry submitted — waiting for an opponent.',
      info: 'Your entry is saved. Once someone joins your battle we’ll create your VS Story automatically — no need to post anything.',
      poll: false,
      canRefresh: false,
    };
  }
  switch (status) {
    case 'live':
      return {
        title: 'Battle ready!',
        subtitle: 'Battle ready! Your VS Story is now live.',
        info: 'The battle is live and fans can vote. Share it to pull in votes — good luck!',
        poll: false,
        canRefresh: false,
      };
    case 'failed':
      return {
        title: 'Battle created',
        subtitle: 'Battle created. We couldn’t prepare your VS Story.',
        info: 'Your battle is live and voting is open — only the VS Story is affected. Our team has been notified.',
        poll: false,
        canRefresh: true,
      };
    case 'unavailable':
      return {
        title: 'Battle created',
        subtitle: 'Battle created.',
        info: 'Your battle is live and fans can vote. Share it to pull in votes — good luck!',
        poll: false,
        canRefresh: false,
      };
    case 'preparing':
    default:
      return {
        title: 'Battle created',
        subtitle: 'Battle created. Preparing your VS Story…',
        info: 'The battle is live and fans can already vote. Your VS Story will appear in a moment.',
        poll: true,
        canRefresh: true,
      };
  }
}
