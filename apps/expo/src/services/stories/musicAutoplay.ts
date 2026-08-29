/**
 * Starting a story's soundtrack WITH SOUND, and coping when the browser says no.
 *
 * Audio used to start muted on every platform. That always "worked" — a muted
 * play is never blocked — but it meant nobody heard a soundtrack without first
 * finding and tapping a pill, which reads as the music being broken.
 *
 * So we now ask for sound immediately. On native there is no policy to satisfy.
 * On web there usually is not either, in practice: reaching the viewer means the
 * user tapped a story, and that gesture gives the document sticky activation for
 * the rest of its life. The case that genuinely fails is a cold deep link opened
 * with no interaction at all.
 *
 * The reason this needs care rather than a one-line change: expo-audio's web
 * backend calls `media.play()` WITHOUT awaiting the promise, and sets its own
 * `isPlaying = true` regardless. A refusal is therefore swallowed twice over —
 * `player.playing` reports true while nothing plays. Left there, the story would
 * be silent while the UI showed a live speaker: a worse failure than starting
 * muted, because it is undiscoverable.
 *
 * `player.paused` is the one honest signal — it reads the media element's real
 * state — so we ask for sound, then check whether it actually started, and fall
 * back to muted playback plus a visible "tap for sound" affordance if it did not.
 */

/**
 * Whether the soundtrack starts audible.
 *
 * True autoplay-with-sound. The fallback below is what makes this safe to assert
 * rather than hope for.
 */
export const STARTS_MUTED = false;

/**
 * How long to wait before deciding a refusal happened.
 *
 * `play()` marks an element unpaused synchronously once it is allowed, even while
 * still buffering, so this does not need to cover network time — only the gap
 * until the browser has acted on the call. Too short risks calling a slow-but-fine
 * start a refusal and needlessly muting; too long leaves real silence on screen.
 */
export const AUTOPLAY_PROBE_MS = 400;

/**
 * When to confirm that sound is genuinely happening, not merely un-paused.
 *
 * `paused` is necessary but NOT sufficient. Measured in Chromium: a source that
 * cannot play reports `paused: false` with `currentTime` stuck at 0 — the element
 * believes it is playing and produces nothing. Only a clock that moves proves
 * audio is being rendered.
 *
 * Longer than the first probe on purpose, because a cold fetch on a slow
 * connection legitimately has not advanced yet. Concluding "blocked" too early
 * only costs a needless mute that one tap undoes, but it should still be rare.
 */
export const AUTOPLAY_CONFIRM_MS = 1_500;

/** State the decision depends on. */
export interface AutoplayState {
  /** The story actually has a soundtrack to play. */
  hasMusic: boolean;
  /** We are currently asking for it muted. */
  muted: boolean;
  /**
   * Nothing else is suppressing playback — the story is not long-pressed, and no
   * sheet or keyboard is up. Without this, a deliberately paused story would be
   * mistaken for a refused one.
   */
  intendedToPlay: boolean;
  /** A refusal has already been established, so stop asking. */
  alreadyBlocked: boolean;
}

/**
 * Whether it is worth checking that sound actually started.
 *
 * Only when we asked for sound, something can play it, and we have not already
 * learnt the answer.
 */
export function shouldProbeAutoplay(s: AutoplayState): boolean {
  return s.hasMusic && !s.muted && s.intendedToPlay && !s.alreadyBlocked;
}

/** What the player reports after we asked it to play with sound. */
export interface PlaybackReading {
  /** The media element's own paused state. NOT `player.playing`, which lies. */
  paused: boolean;
  /**
   * Whether the playback clock moved since the attempt.
   *
   * Only meaningful once enough time has passed to expect movement — pass false
   * with `confirmed: false` during the first, fast probe.
   */
  progressed: boolean;
  /** True once the confirm window has elapsed, making `progressed` conclusive. */
  confirmed: boolean;
}

/**
 * Whether an unmuted start failed to produce audio.
 *
 * Two independent signals, because neither alone is enough:
 *
 *   `paused`      — the element never started. This is what a blocked autoplay
 *                   looks like, and it is knowable quickly.
 *   `!progressed` — the element claims to be playing but its clock has not moved.
 *                   Measured in Chromium: a source that cannot play reports
 *                   `paused: false` with `currentTime` pinned at 0. Only checked
 *                   once `confirmed`, so slow buffering is not called a failure.
 *
 * `player.playing` is never consulted: expo-audio's web backend sets it true
 * inside `play()` whether or not the browser honoured the call.
 *
 * Guarded by `intendedToPlay` so a story paused mid-probe is not misread, and by
 * `!muted` so a user muting mid-probe does not register as a failure.
 */
export function autoplayRefused(
  s: Pick<AutoplayState, 'muted' | 'intendedToPlay'> & PlaybackReading,
): boolean {
  if (s.muted || !s.intendedToPlay) return false;
  if (s.paused) return true;
  return s.confirmed && !s.progressed;
}

/**
 * Why the soundtrack is silent, kept apart because the two behave differently
 * when the story advances.
 *
 * A refusal belongs to one story: the next one deserves a fresh attempt, and by
 * then a tap has almost certainly happened. A deliberate mute belongs to the
 * viewer and must survive — silently restoring sound on the next story, after
 * someone asked for quiet, is worse than never autoplaying at all.
 */
export interface MuteState {
  /** The viewer asked for quiet. Sticky across stories. */
  userMuted: boolean;
  /** The browser refused sound for THIS story. Reset when the story changes. */
  soundBlocked: boolean;
}

/** Either reason silences the track. */
export function isMutedNow(s: MuteState): boolean {
  return s.userMuted || s.soundBlocked;
}

/**
 * The pill press.
 *
 * Turning sound ON must clear BOTH reasons — the tap is itself the gesture a
 * browser was waiting for, so a previous refusal no longer applies. Toggling
 * `userMuted` alone would leave a blocked story stuck silent no matter how often
 * it was tapped.
 */
export function toggleMute(s: MuteState): MuteState {
  if (isMutedNow(s)) return { userMuted: false, soundBlocked: false };
  return { userMuted: true, soundBlocked: false };
}

/**
 * What the music pill should say.
 *
 * Muted is muted, whatever the reason — a refused autoplay and a user-muted track
 * both need the same one-tap remedy, and naming the action is what stops a
 * deliberately silent story from reading as a broken one. A crossed-out speaker
 * beside a song title looks like a now-playing label, which is how "music does not
 * play" got reported in the first place.
 */
export function musicPillLabel(muted: boolean, title?: string | null, artist?: string | null): string {
  if (muted) return title ? `Tap for sound · ${title}` : 'Tap for sound';
  if (!title) return 'Music';
  return artist ? `${title} · ${artist}` : title;
}
