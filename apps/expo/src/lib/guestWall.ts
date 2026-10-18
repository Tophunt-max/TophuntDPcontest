/**
 * The soft login wall on the home feed (Instagram web's "Log in to see more").
 *
 * A guest browses freely; once they have SEEN `GUEST_WALL_EVERY` battles the
 * feed shows a dismissible "See more on TopHunt" sheet. "Not now" closes it,
 * and it comes back after every further `GUEST_WALL_EVERY` battles. It never
 * blocks scrolling — this is a nudge, not a gate; the Worker enforces nothing
 * here and nothing private is behind it.
 *
 * "Seen" means the furthest feed position that has been on screen, so scrolling
 * back up and down again does not count twice.
 */
export const GUEST_WALL_EVERY = 12;

/** The number of seen battles at which the wall shows next, after `dismissals` "Not now" taps. */
export function nextGuestWallAt(dismissals: number): number {
  return GUEST_WALL_EVERY * (Math.max(0, Math.floor(dismissals)) + 1);
}

export function shouldShowGuestWall(opts: { isGuest: boolean; seen: number; dismissals: number }): boolean {
  return opts.isGuest && opts.seen >= nextGuestWallAt(opts.dismissals);
}

/** Seen count from the indices currently on screen, never moving backwards. */
export function seenAfterViewable(previousSeen: number, visibleIndices: (number | null | undefined)[]): number {
  let max = previousSeen;
  for (const i of visibleIndices) {
    if (typeof i === 'number' && i + 1 > max) max = i + 1;
  }
  return max;
}
