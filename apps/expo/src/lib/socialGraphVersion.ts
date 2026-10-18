/**
 * A counter that increments whenever the signed-in user changes who they can see
 * — currently blocking, unblocking, muting or unmuting someone.
 *
 * Why this exists: most list screens in the app are react-query backed and are
 * invalidated directly, but the home feed is not. It holds its battles in
 * component state and loads them in an effect keyed on the feed tab, so the most
 * natural sequence a user performs —
 *
 *     tap a battle → open the profile → Block → go back
 *
 * lands them back on a feed that is still showing the battle they just blocked.
 * The server already filters it; the screen simply has no reason to ask again.
 *
 * Rather than convert the feed to react-query (a much larger change to the
 * hottest screen in the app), screens read this version on focus and reload only
 * when it has moved since their last load. A screen that is already up to date
 * does nothing, so this costs no extra requests in the common case.
 */
let version = 0;

const listeners = new Set<() => void>();

/** Call after any change to blocks or mutes. */
export function bumpSocialGraphVersion(): void {
  version += 1;
  // Persistent caches holding viewer-filtered content (the Home feed snapshot)
  // subscribe here so a block/mute also invalidates what survives a restart —
  // the version counter itself is session-only.
  for (const fn of listeners) {
    try {
      fn();
    } catch (e) {
      console.warn('[socialGraphVersion] listener failed (continuing)', e);
    }
  }
}

/** Run `fn` after every block/mute change. Returns an unsubscribe. */
export function onSocialGraphChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The current version. Compare against the value held when data was last loaded. */
export function getSocialGraphVersion(): number {
  return version;
}
