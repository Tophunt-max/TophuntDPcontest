/**
 * Music catalogue lookups for story soundtracks.
 *
 * WHY THE WORKER DOES THIS AT ALL, instead of the app calling the provider:
 *
 *  1. IT COULD NOT WORK FROM THE BROWSER. The story editor called
 *     `fetch('https://itunes.apple.com/search?…')` directly, and the site's CSP
 *     `connect-src` does not list that host — so on the web every search was
 *     blocked before it left the page. The failure was swallowed by a
 *     `console.error`, so the picker just sat empty forever. Routing through
 *     `api.tophunt.in`, which the CSP already allows, is what makes the feature
 *     exist on the web at all.
 *  2. CACHING. "Top Hits" is the default query every user sees; without a cache
 *     that is one outbound request per person per open.
 *  3. ONE PLACE TO CHANGE PROVIDER. The app now knows only our own shape.
 *
 * The provider is the public iTunes Search API: no key, no account, and it
 * returns a 30-second preview stream per track. That last point is the important
 * one and is a deliberate product limit, not an oversight — see PREVIEW_ONLY
 * below.
 */
import type { Env } from "../types";
import { cacheGetJson, cachePutJson } from "./cache";

/**
 * PREVIEW_ONLY.
 *
 * What we attach to a story is Apple's public 30-second PREVIEW clip, the same
 * asset the iTunes Store plays to anonymous visitors. We are not licensed to
 * distribute full recordings, and nothing here should ever be changed to serve
 * one: no full-length URL is requested, stored or returned, and tracks without a
 * preview are dropped rather than linked some other way.
 *
 * A story is capped at well under this by its own 24-hour lifetime and the
 * viewer's per-story duration, so the clip is never the limiting factor in
 * practice.
 */
export const PREVIEW_SECONDS = 30;

/** The shape the app receives. Deliberately not the provider's shape. */
export interface MusicTrack {
  id: string;
  title: string;
  artist: string;
  /** Square cover art, or null. */
  artworkUrl: string | null;
  /** 30-second preview stream. Never null — see `normalizeTrack`. */
  previewUrl: string;
}

const SEARCH_ENDPOINT = "https://itunes.apple.com/search";
const LOOKUP_ENDPOINT = "https://itunes.apple.com/lookup";
/** Outbound calls get a short leash: this sits on a user-facing request. */
const TIMEOUT_MS = 6000;

/**
 * Provider row -> our shape, or null when the row is unusable.
 *
 * A track WITHOUT a preview stream is dropped rather than returned. Apple omits
 * `previewUrl` for some catalogue entries, and showing one would give the user a
 * result that silently plays nothing when tapped — which is exactly the class of
 * bug this whole change is fixing.
 *
 * Artwork is upgraded from the 100px thumbnail the API returns to 300px, because
 * the editor's sticker and the viewer both render it larger than 100px and it
 * looked soft. It is a plain string substitution on Apple's own URL scheme; if
 * the scheme ever changes the original URL is left untouched.
 */
export function normalizeTrack(row: any): MusicTrack | null {
  const previewUrl = typeof row?.previewUrl === "string" ? row.previewUrl : "";
  if (!previewUrl) return null;
  const id = row?.trackId != null ? String(row.trackId) : "";
  if (!id) return null;
  const artwork = typeof row?.artworkUrl100 === "string" ? row.artworkUrl100 : null;
  return {
    id,
    title: typeof row?.trackName === "string" ? row.trackName : "Unknown track",
    artist: typeof row?.artistName === "string" ? row.artistName : "Unknown artist",
    artworkUrl: artwork ? artwork.replace("100x100bb", "300x300bb") : null,
    previewUrl,
  };
}

async function fetchJson(url: string): Promise<any | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    // A provider that is down, slow or rate-limiting us is not an error the user
    // can act on. Callers turn null into an empty result or "no music".
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Search the catalogue. Returns [] when the provider is unreachable — never
 * throws, because a failed search must not take down the story editor.
 *
 * Cached per normalised query. The TTL is long (6h) on purpose: a music
 * catalogue does not move, and the default "Top Hits" query is requested by
 * every user who opens the picker.
 */
export async function searchTracks(env: Env, query: string, limit = 20): Promise<MusicTrack[]> {
  const q = query.trim().slice(0, 80);
  if (!q) return [];
  const capped = Math.min(Math.max(limit, 1), 25);
  const cacheKey = `cache:music:search:${capped}:${q.toLowerCase()}`;

  const cached = await cacheGetJson<MusicTrack[]>(env, cacheKey);
  if (cached) return cached;

  const url = `${SEARCH_ENDPOINT}?term=${encodeURIComponent(q)}&media=music&entity=song&limit=${capped}`;
  const data = await fetchJson(url);
  const rows: any[] = Array.isArray(data?.results) ? data.results : [];
  const tracks = rows.map(normalizeTrack).filter((t): t is MusicTrack => t !== null);

  // Only a non-empty result is cached. Caching [] would pin a transient provider
  // outage for six hours, and the picker would stay empty long after it recovered.
  if (tracks.length > 0) await cachePutJson(env, cacheKey, tracks, 6 * 60 * 60);
  return tracks;
}

/**
 * Resolve one track id to its authoritative record.
 *
 * This is what lets `createStory` accept ONLY an id from the client. Taking the
 * title, artist, artwork and preview URL from the client instead would let any
 * caller have an arbitrary URL loaded by every viewer's browser — a way to log
 * the IP and user-agent of everyone who watches a story, from a domain the
 * viewer trusts. One subrequest on a rate-limited, once-per-story write removes
 * that outright.
 *
 * Returns null when the id is unknown or the provider is unreachable. The caller
 * must then create the story WITHOUT music rather than fail the upload: the user
 * has already waited through a media upload, and losing it over a soundtrack
 * would be the wrong trade.
 */
export async function lookupTrack(env: Env, trackId: string): Promise<MusicTrack | null> {
  const id = String(trackId ?? "").trim();
  // Apple track ids are numeric. Rejecting anything else here means nothing
  // user-controlled is ever interpolated into the outbound URL.
  if (!/^\d{1,20}$/.test(id)) return null;

  const cacheKey = `cache:music:track:${id}`;
  const cached = await cacheGetJson<MusicTrack>(env, cacheKey);
  if (cached) return cached;

  const data = await fetchJson(`${LOOKUP_ENDPOINT}?id=${id}&entity=song`);
  const rows: any[] = Array.isArray(data?.results) ? data.results : [];
  const track = rows.map(normalizeTrack).find((t): t is MusicTrack => t !== null) ?? null;
  if (track) await cachePutJson(env, cacheKey, track, 24 * 60 * 60);
  return track;
}
