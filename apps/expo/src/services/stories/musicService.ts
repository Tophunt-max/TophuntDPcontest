import { readApi } from '../api';

/**
 * Story soundtracks.
 *
 * The editor used to call `https://itunes.apple.com/search` straight from the
 * client. On the web that could never work: the site's CSP `connect-src` does not
 * list that host, so the browser blocked every request before it left the page —
 * and the failure was caught by a bare `console.error`, so the picker just stayed
 * empty with no spinner, no message and nothing to retry. That was "music not
 * working".
 *
 * Search now goes through our own Worker (`/read/music/search`), which the CSP
 * already allows, caches upstream, and is the single place the provider could be
 * swapped. See apps/worker/src/lib/music.ts.
 */

/** Mirrors the Worker's `MusicTrack`. `previewUrl` is never empty. */
export interface MusicTrack {
  id: string;
  title: string;
  artist: string;
  artworkUrl: string | null;
  previewUrl: string;
}

/** The query used when the picker first opens. */
export const DEFAULT_MUSIC_QUERY = 'Top Hits';

/**
 * Search the catalogue.
 *
 * THROWS on transport failure, deliberately — the same distinction the blog list
 * had to learn. "I could not reach the server" and "there are no results for
 * this" are different facts, and only the caller can render them differently. The
 * old code collapsed both into an empty list, which is why a blocked request was
 * indistinguishable from an obscure search term.
 */
export const searchMusic = async (query: string, limit = 20): Promise<MusicTrack[]> => {
  const q = query.trim();
  if (!q) return [];
  const res: any = await readApi('/read/music/search', { q, limit });
  const items = Array.isArray(res?.items) ? res.items : [];
  // A track with no preview cannot be played; the Worker already drops these, so
  // this is belt-and-braces against an older deployment.
  return items.filter((t: any) => t && typeof t.previewUrl === 'string' && t.previewUrl);
};
