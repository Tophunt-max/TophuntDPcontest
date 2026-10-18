/**
 * The viewer's relationship to another account, as the Follow button shows it.
 *
 * Mirrors the Worker's `FollowState` (apps/worker/src/lib/privateAccount.ts).
 * `requested` is a pending follow request to a PRIVATE account: it is not a
 * follow, so nothing behind the profile header unlocks until the owner
 * confirms it.
 */
export type FollowState = 'self' | 'following' | 'requested' | 'none';

/** What a tap asks the server for (the `toggleFollow` action's `intent`). */
export type FollowIntent = 'follow' | 'unfollow' | 'cancel';

/** The intent of tapping a button that currently shows `state`. */
export function intentFor(state: FollowState): FollowIntent {
  if (state === 'following') return 'unfollow';
  if (state === 'requested') return 'cancel';
  return 'follow';
}

/** Shape of the `toggleFollow` action's answer. */
export interface ToggleFollowResult {
  isFollowing?: boolean;
  requested?: boolean;
}

/** The state after a `toggleFollow` call, from the server's answer. */
export function followStateFromResult(r: ToggleFollowResult | null | undefined): FollowState {
  if (r?.isFollowing) return 'following';
  if (r?.requested) return 'requested';
  return 'none';
}

/** What the state will be if the user taps the button now (for an optimistic update). */
export function nextFollowState(current: FollowState, targetIsPrivate: boolean): FollowState {
  if (current === 'following' || current === 'requested') return 'none';
  if (current === 'self') return 'self';
  return targetIsPrivate ? 'requested' : 'following';
}

export function followButtonLabel(state: FollowState): string {
  switch (state) {
    case 'following':
      return 'Following';
    case 'requested':
      return 'Requested';
    default:
      return 'Follow';
  }
}

/** True when the button should render in its "active" (outlined) style. */
export function isFollowActive(state: FollowState): boolean {
  return state === 'following' || state === 'requested';
}

/** The state of `id` in a list screen that tracks follows and requests as two sets. */
export function stateInSets(followed: ReadonlySet<string>, requested: ReadonlySet<string>, id: string): FollowState {
  if (followed.has(id)) return 'following';
  if (requested.has(id)) return 'requested';
  return 'none';
}

/** New copies of both sets with `id` moved to `state`. */
export function withStateInSets(
  followed: ReadonlySet<string>,
  requested: ReadonlySet<string>,
  id: string,
  state: FollowState,
): { followed: Set<string>; requested: Set<string> } {
  const f = new Set(followed);
  const r = new Set(requested);
  f.delete(id);
  r.delete(id);
  if (state === 'following') f.add(id);
  if (state === 'requested') r.add(id);
  return { followed: f, requested: r };
}
