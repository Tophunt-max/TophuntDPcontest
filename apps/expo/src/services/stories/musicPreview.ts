import type { MusicTrack } from './musicService';

/**
 * Auditioning a track in the picker versus attaching it to the story.
 *
 * These were the same action. The picker's play button was a bare `play-circle`
 * icon rendered inside the row's own `onPress`, so tapping it could only do what
 * the row did: attach the track and dismiss the sheet. There was no way to hear a
 * track before committing to it, and pressing play looked broken because it
 * behaved like a select.
 *
 * The rules live here, apart from the screen, because they are the part that was
 * wrong and the part worth pinning: a preview must never change the selection,
 * and only one thing may ever be audible.
 */

/**
 * What the preview should be after tapping a row's transport button.
 *
 * Tapping the row already playing stops it, so one button serves as play and
 * pause. Returns the *preview* only — the caller's selection is not this
 * function's business, which is the whole point.
 */
export function nextPreview(
  current: MusicTrack | null,
  tapped: MusicTrack,
): MusicTrack | null {
  return current?.id === tapped.id ? null : tapped;
}

/**
 * The single track that should be loaded in the player.
 *
 * An audition outranks the attached track: while the picker is open the user is
 * asking to hear the row they tapped, not the song already on the story.
 */
export function audibleTrack(
  previewTrack: MusicTrack | null,
  selectedMusic: MusicTrack | null,
): MusicTrack | null {
  return previewTrack ?? selectedMusic;
}

/**
 * Whether that track should be playing.
 *
 * An audition is always meant to be heard — a user who pressed play gets sound
 * without also having to un-pause the sticker. The attached track instead follows
 * the sticker's own play/pause button.
 */
export function shouldPlay(
  previewTrack: MusicTrack | null,
  selectedMusic: MusicTrack | null,
  isMusicPlaying: boolean,
): boolean {
  if (previewTrack) return true;
  return !!selectedMusic && isMusicPlaying;
}
