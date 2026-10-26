/**
 * When a feed video may play.
 *
 * Every mounted feed card used to create its players and call play() on
 * mount. FlatList keeps about 7 screens of cards mounted (windowSize 7), and a
 * video battle has two players, so a scroll through a video-heavy feed had
 * well over ten videos decoding and downloading at once, most off screen.
 * They kept going after the user opened another screen, because Home stays
 * mounted underneath.
 *
 * Now a video plays only when its card is on screen (at least half visible,
 * Home's viewability threshold), Home is the focused screen, the app is in the
 * foreground, and the user has not asked the OS to reduce motion.
 */

export interface PlaybackContext {
  /** The card is on screen. */
  visible: boolean;
  /** Home is the focused route (nothing pushed on top of it). */
  screenFocused: boolean;
  /** AppState is 'active'. */
  appActive: boolean;
  /** The OS "reduce motion" setting. Autoplaying video is motion. */
  reduceMotion: boolean;
}

export function shouldAutoplay(c: PlaybackContext): boolean {
  return c.visible && c.screenFocused && c.appActive && !c.reduceMotion;
}

/** Ids of the cards FlatList reports as viewable. No look-ahead: that is for sockets, not decoders. Pure. */
export function visibleIdsFor(viewable: { item: any }[]): Set<string> {
  const ids = new Set<string>();
  for (const v of viewable) {
    if (v.item && typeof v.item === 'object' && typeof v.item.id === 'string') ids.add(v.item.id);
  }
  return ids;
}
