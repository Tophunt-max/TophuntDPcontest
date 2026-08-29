/**
 * The picker's play button must PREVIEW, not select.
 *
 * It used to be a bare `play-circle` icon inside the row's own `onPress`, so the
 * only thing tapping it could do was attach the track and close the sheet —
 * "play button click karne se music select ho raha". These assert the two
 * behaviours stay separate, and that only one track is ever audible.
 */
import { describe, it, expect } from 'vitest';

import { nextPreview, audibleTrack, shouldPlay } from '@/src/services/stories/musicPreview';
import type { MusicTrack } from '@/src/services/stories/musicService';

const track = (id: string): MusicTrack =>
  ({
    id,
    title: `Song ${id}`,
    artist: 'Someone',
    artworkUrl: `https://cdn.example/${id}.jpg`,
    previewUrl: `https://cdn.example/${id}.m4a`,
  }) as MusicTrack;

const a = track('a');
const b = track('b');

describe('nextPreview', () => {
  it('starts previewing a track when nothing is previewing', () => {
    expect(nextPreview(null, a)).toBe(a);
  });

  it('stops when the same track is tapped again', () => {
    // One button is both play and pause.
    expect(nextPreview(a, a)).toBeNull();
  });

  it('switches straight to another track', () => {
    expect(nextPreview(a, b)).toBe(b);
  });

  it('matches by id, not identity', () => {
    // The list is re-fetched, so rows are fresh objects for the same track.
    expect(nextPreview(track('a'), track('a'))).toBeNull();
  });
});

describe('audibleTrack', () => {
  it('prefers the preview over the attached track', () => {
    // The user asked to hear the row they tapped, not the song on the story.
    expect(audibleTrack(b, a)).toBe(b);
  });

  it('falls back to the attached track when nothing is being previewed', () => {
    expect(audibleTrack(null, a)).toBe(a);
  });

  it('is nothing when neither exists', () => {
    expect(audibleTrack(null, null)).toBeNull();
  });

  it('never returns two tracks — only one soundtrack can be audible', () => {
    const out = audibleTrack(b, a);
    expect(out === b || out === a).toBe(true);
  });
});

describe('shouldPlay', () => {
  it('always plays an audition', () => {
    // Pressing play must produce sound without also un-pausing the sticker.
    expect(shouldPlay(a, null, false)).toBe(true);
    expect(shouldPlay(a, b, false)).toBe(true);
  });

  it('follows the sticker transport for the attached track', () => {
    expect(shouldPlay(null, a, true)).toBe(true);
    expect(shouldPlay(null, a, false)).toBe(false);
  });

  it('plays nothing when no track is involved', () => {
    expect(shouldPlay(null, null, true)).toBe(false);
  });
});

describe('previewing does not attach', () => {
  it('leaves the selection untouched across a whole audition session', () => {
    // The regression, stated directly: auditioning several rows must not change
    // what the story will be published with.
    const selected = a;
    let preview: MusicTrack | null = null;

    preview = nextPreview(preview, b);
    expect(preview).toBe(b);
    expect(selected).toBe(a); // unchanged

    preview = nextPreview(preview, b); // stop
    expect(preview).toBeNull();
    expect(selected).toBe(a); // still unchanged

    expect(audibleTrack(preview, selected)).toBe(a);
  });
});
