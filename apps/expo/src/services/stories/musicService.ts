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

/** One browsable group of curated tracks. */
export interface MusicCategory {
  key: string;
  label: string;
  tracks: MusicTrack[];
}

export interface MusicSearchResult {
  tracks: MusicTrack[];
  /**
   * True when nothing matched AND the provider fallback could not answer — as
   * opposed to "there is genuinely no such song". Collapsing those two into an
   * empty array is what made a throttled provider look like an empty search box.
   */
  providerFailed: boolean;
}

const playable = (items: any): MusicTrack[] =>
  (Array.isArray(items) ? items : []).filter(
    (t: any) => t && typeof t.previewUrl === 'string' && t.previewUrl,
  );

/**
 * The curated catalogue the picker shows as soon as it opens.
 *
 * This replaced a live "Top Hits" search against the provider, which could not
 * work: that API throttles per source IP, our Worker's egress is shared, and it
 * answered "200 OK, zero results" — so the sheet was permanently empty with no
 * error to show. The catalogue is our own data, so there is nothing to throttle.
 *
 * THROWS on transport failure; the caller renders that as a retry.
 */
export const fetchMusicCatalog = async (): Promise<MusicCategory[]> => {
  const res: any = await readApi('/read/music/catalog');
  const categories = Array.isArray(res?.categories) ? res.categories : [];
  return categories
    .map((c: any) => ({ key: c?.key, label: c?.label, tracks: playable(c?.tracks) }))
    // A category with no playable track would be a tab that opens onto nothing.
    .filter((c: MusicCategory) => c.key && c.label && c.tracks.length > 0);
};

/**
 * Search: our curated catalogue first, then the provider for anything outside it.
 *
 * THROWS on transport failure, deliberately — the same distinction the blog list
 * had to learn. "I could not reach the server" and "there are no results for this"
 * are different facts, and only the caller can render them differently.
 */
export const searchMusic = async (query: string, limit = 20): Promise<MusicSearchResult> => {
  const q = query.trim();
  if (!q) return { tracks: [], providerFailed: false };
  const res: any = await readApi('/read/music/search', { q, limit });
  return { tracks: playable(res?.items), providerFailed: !!res?.providerFailed };
};
