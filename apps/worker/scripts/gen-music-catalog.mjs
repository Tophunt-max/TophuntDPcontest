/**
 * Generate the curated music catalogue migration.
 *
 * WHY A CURATED TABLE INSTEAD OF A LIVE PROVIDER CALL
 *
 * The picker's first version asked the provider for "Top Hits" every time it
 * opened. That worked from a laptop and returned NOTHING from the deployed
 * Worker: Apple's iTunes Search API rate-limits per source IP, and a Worker's
 * egress address is shared with an enormous amount of other traffic, so our
 * requests get throttled to an empty result set. The user saw an empty sheet with
 * no explanation — the provider had answered "200 OK, zero results".
 *
 * Depending on an unauthenticated, undocumented, IP-throttled third party at the
 * moment a user opens a sheet was the mistake. This script resolves the catalogue
 * ONCE, here, from a machine that is not rate-limited, and bakes the result into a
 * migration. At runtime the Worker reads its own table: no outbound request, no
 * shared-IP throttling, and the same list for everybody.
 *
 * It is also what "like Instagram" actually means. Instagram does not live-query a
 * third party when you open its music sheet; it serves its own catalogue, grouped
 * into browsable categories. This is that.
 *
 * PREVIEW_ONLY: every `preview_url` is Apple's public 30-second preview — the same
 * asset the iTunes Store plays to anonymous visitors. No full-length URL is
 * requested or stored. Tracks without a preview are skipped.
 *
 * Usage: node scripts/gen-music-catalog.mjs > migrations/0036_music_catalog.sql
 */

/**
 * Browsable categories, ordered as they should appear.
 *
 * `terms` are search phrases used only at GENERATION time; they never ship. The
 * market is India (the app prices in ₹), so `country=IN` is used and the mix is
 * weighted accordingly rather than defaulting to the US chart.
 */
const CATEGORIES = [
  { key: 'trending', label: 'Trending', terms: ['trending hindi songs', 'top hits india'] },
  { key: 'bollywood', label: 'Bollywood', terms: ['bollywood hits', 'arijit singh', 'shreya ghoshal'] },
  { key: 'punjabi', label: 'Punjabi', terms: ['punjabi hits', 'diljit dosanjh'] },
  { key: 'romance', label: 'Romance', terms: ['romantic hindi', 'love songs hindi'] },
  { key: 'party', label: 'Party', terms: ['party anthems hindi', 'dance hits india'] },
  { key: 'chill', label: 'Chill', terms: ['lofi chill', 'acoustic chill hindi'] },
];

const PER_TERM = 10;
/** Hard cap so the migration stays small and reviewable. */
const PER_CATEGORY = 12;

const sq = (v) => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

async function fetchTerm(term) {
  const url =
    'https://itunes.apple.com/search?term=' +
    encodeURIComponent(term) +
    `&media=music&entity=song&limit=${PER_TERM}&country=IN`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${term}: HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data?.results) ? data.results : [];
}

/** Same normalisation the Worker applies, so generated rows match runtime rules. */
function normalize(row) {
  const previewUrl = typeof row?.previewUrl === 'string' ? row.previewUrl : '';
  if (!previewUrl) return null;
  const id = row?.trackId != null ? String(row.trackId) : '';
  if (!id) return null;
  const artwork = typeof row?.artworkUrl100 === 'string' ? row.artworkUrl100 : null;
  return {
    id,
    title: typeof row?.trackName === 'string' ? row.trackName : null,
    artist: typeof row?.artistName === 'string' ? row.artistName : null,
    artworkUrl: artwork ? artwork.replace('100x100bb', '300x300bb') : null,
    previewUrl,
  };
}

const rows = [];
const seen = new Set();

for (const cat of CATEGORIES) {
  let taken = 0;
  for (const term of cat.terms) {
    if (taken >= PER_CATEGORY) break;
    let results = [];
    try {
      results = await fetchTerm(term);
    } catch (e) {
      process.stderr.write(`[warn] ${e.message}\n`);
      continue;
    }
    for (const raw of results) {
      if (taken >= PER_CATEGORY) break;
      const t = normalize(raw);
      // Dedupe across categories: a track belongs to exactly one, so the picker
      // never shows the same song twice.
      if (!t || !t.title || !t.artist || seen.has(t.id)) continue;
      seen.add(t.id);
      rows.push({ ...t, category: cat.key, sortOrder: taken });
      taken++;
    }
  }
  process.stderr.write(`[gen] ${cat.key}: ${taken} track(s)\n`);
}

if (rows.length === 0) {
  process.stderr.write('[gen] refusing to emit an empty catalogue\n');
  process.exit(1);
}

const catLines = CATEGORIES.map(
  (c, i) =>
    `INSERT OR IGNORE INTO music_categories (key, label, sort_order) VALUES (${sq(c.key)}, ${sq(c.label)}, ${i});`,
);

const trackLines = rows.map(
  (t) =>
    `INSERT OR IGNORE INTO music_tracks (id, title, artist, artwork_url, preview_url, category, sort_order, is_active) ` +
    `VALUES (${sq(t.id)}, ${sq(t.title)}, ${sq(t.artist)}, ${sq(t.artworkUrl)}, ${sq(t.previewUrl)}, ${sq(t.category)}, ${t.sortOrder}, 1);`,
);

process.stdout.write(`-- The curated music catalogue the story picker reads.
--
-- GENERATED by scripts/gen-music-catalog.mjs. Do not hand-edit rows; re-run the
-- script and emit a NEW migration instead, so the change is reviewable.
--
-- WHY THE CATALOGUE LIVES IN OUR OWN DATABASE
--
-- The picker's first version asked Apple's iTunes Search API for "Top Hits" every
-- time it opened. That worked from a laptop and returned NOTHING from the
-- deployed Worker: the API rate-limits per source IP, and a Worker's egress
-- address is shared with a very large amount of other traffic, so our requests
-- were throttled to "200 OK, zero results". The sheet came up empty with no
-- explanation, because an empty result and a throttled request were the same
-- response.
--
-- Making a user-facing sheet depend on an unauthenticated, undocumented,
-- IP-throttled third party AT THE MOMENT IT OPENS was the mistake. These rows are
-- resolved once, offline, from a machine that is not throttled. At runtime the
-- Worker reads this table: no outbound request, nothing to rate-limit, and the
-- same list for every user.
--
-- It is also what "like Instagram" means in practice. Instagram does not
-- live-query a third party when its music sheet opens; it serves its own
-- catalogue in browsable categories. This is that.
--
-- PREVIEW_ONLY: every preview_url is Apple's public 30-second preview, the same
-- asset the iTunes Store plays to anonymous visitors. No full-length audio is
-- referenced, and tracks without a preview were skipped at generation time. We
-- host no audio — these are links.
--
-- Preview URLs can rotate. A dead one must render as "no music" rather than a
-- broken story, and the fix is to re-run the generator and ship a new migration.
-- \`is_active\` exists so a track can be retired without deleting rows that stories
-- already reference.
--
-- Seeded IN the migration rather than a separate script because the feature does
-- not work without it: this is reference data, not a data rewrite, and every
-- statement is INSERT OR IGNORE so re-application is a no-op.

CREATE TABLE IF NOT EXISTS music_categories (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS music_tracks (
  -- The provider's track id. Also what a client sends as \`musicTrackId\`, so a
  -- curated pick needs no outbound lookup when the story is created.
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  artwork_url TEXT,
  preview_url TEXT NOT NULL,
  category TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1
);

-- Serves the only read pattern: active tracks for one category, in order.
CREATE INDEX IF NOT EXISTS idx_music_tracks_category
  ON music_tracks (category, is_active, sort_order);

${catLines.join('\n')}

${trackLines.join('\n')}
`);

process.stderr.write(`[gen] emitted ${rows.length} track(s) across ${CATEGORIES.length} categories\n`);
