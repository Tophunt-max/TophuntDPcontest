#!/usr/bin/env node
/**
 * TopHunt archive importer
 * =========================
 * Recovers the old tophunt.in WordPress posts from the Internet Archive
 * (Wayback Machine) and loads them into the TopHunt blog via the Worker's
 * bulk endpoint  POST {WORKER_URL}/admin/blog/import  (secured by X-Admin-Secret).
 *
 * How it works
 *   1. Query the Wayback CDX API for every archived tophunt.in URL that returned
 *      200 text/html, and keep the LATEST snapshot of each real post permalink
 *      (system/taxonomy/asset URLs are filtered out).
 *   2. For each post, fetch the rendered Wayback snapshot (NOT the `id_` raw
 *      form) so that in-content <img> and og:image URLs are rewritten to
 *      permanent web.archive.org copies — this matches image strategy (a):
 *      keep the Wayback-hosted images, no re-upload needed.
 *   3. Extract title / excerpt / cover image / date / category / body HTML.
 *   4. Batch the parsed posts and POST them to the Worker, which upserts them
 *      into D1 (dedup by originalUrl — safe to re-run).
 *
 * Usage
 *   npm install
 *   WORKER_URL=https://tophunt-api.<sub>.workers.dev \
 *   ADMIN_PROXY_SECRET=<secret> \
 *   node import.mjs [flags]
 *
 * Flags / env
 *   --dry-run            Parse only; print results, do not POST.
 *   --urls-only          Just fetch + print the recoverable post URLs and exit.
 *   --limit=N            Only process the first N posts (great for testing).
 *   --offset=N           Skip the first N posts (resume).
 *   --concurrency=N      Parallel fetches from archive.org (default 4).
 *   --batch=N            Posts per POST to the Worker (default 25).
 *   --out=file.json      Also write all parsed posts to a JSON file.
 *   --delay=ms           Delay between snapshot fetches per worker (default 300).
 */

import { parse } from "node-html-parser";
import fs from "node:fs";

// --------------------------------------------------------------------------
// Config
// --------------------------------------------------------------------------
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (name, def) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split("=")[1] : def;
};

const DRY_RUN = has("--dry-run");
const URLS_ONLY = has("--urls-only");
const LIMIT = parseInt(val("limit", "0"), 10) || 0;
const OFFSET = parseInt(val("offset", "0"), 10) || 0;
const CONCURRENCY = parseInt(val("concurrency", "4"), 10) || 4;
const BATCH = parseInt(val("batch", "25"), 10) || 25;
const DELAY = parseInt(val("delay", "300"), 10) || 300;
const OUT = val("out", "");

const WORKER_URL = (process.env.WORKER_URL || "").replace(/\/$/, "");
const ADMIN_PROXY_SECRET = process.env.ADMIN_PROXY_SECRET || "";
const DOMAIN = process.env.ARCHIVE_DOMAIN || "tophunt.in";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

/** fetch with retry + exponential backoff for archive.org's rate limits (429/503). */
async function fetchRetry(url, init = {}, tries = 5) {
  let lastErr;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.status === 429 || res.status === 503) {
        lastErr = new Error(`rate-limited ${res.status}`);
      } else {
        return res;
      }
    } catch (e) {
      lastErr = e;
    }
    await sleep(1000 * Math.pow(2, attempt) + Math.random() * 500); // 1s,2s,4s,8s,16s
  }
  throw lastErr || new Error("fetch failed");
}

// URLs we never want as blog posts (WP system, taxonomy, feeds, assets).
const EXCLUDE = /(\?|\/\.well-known|\/wp-|\/feed|\/category\/|\/tag\/|\/author\/|\/page\/|\/comments\/|\/amp\/$)/i;
const ASSET_EXT = /\.(json|txt|xml|css|js|png|jpe?g|gif|svg|ico|webp|pdf|zip|mp4)$/i;

// --------------------------------------------------------------------------
// Step 1 — collect the latest snapshot of every real post permalink
// --------------------------------------------------------------------------
async function fetchPostSnapshots() {
  log("→ Querying Wayback CDX for", DOMAIN, "…");
  const cdx =
    `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(DOMAIN)}*` +
    `&output=json&fl=original,timestamp,statuscode,mimetype` +
    `&filter=statuscode:200&filter=mimetype:text/html`;
  const res = await fetchRetry(cdx);
  if (!res.ok) throw new Error(`CDX request failed: ${res.status}`);
  const rows = await res.json();
  // rows[0] is the header
  const byKey = new Map(); // normalizedUrl -> { url, timestamps: Set }
  for (let i = 1; i < rows.length; i++) {
    let [original, timestamp] = rows[i];
    if (!original) continue;
    // Strip trailing encoded newlines/whitespace (%0A/%0D) that some crawls
    // appended, so broken variants merge with the clean permalink.
    original = original.replace(/(%0[aAdD]|%20|\s)+$/g, "");
    if (EXCLUDE.test(original) || ASSET_EXT.test(original)) continue;
    // skip the bare homepage
    const path = original.replace(/^https?:\/\/[^/]+(:80)?/i, "");
    if (path === "" || path === "/") continue;
    // normalize http/https + :80 + trailing slash for dedup
    const key = original
      .replace(/^https?:\/\//i, "")
      .replace(":80/", "/")
      .replace(/\/$/, "")
      .toLowerCase();
    let entry = byKey.get(key);
    if (!entry) {
      entry = { url: original, timestamps: new Set() };
      byKey.set(key, entry);
    }
    entry.timestamps.add(timestamp);
  }
  const list = [...byKey.values()].map((e) => ({
    url: e.url,
    // Oldest-first: the site was healthy for years, only the recent outage
    // produced broken 200 snapshots. Oldest good capture = real content.
    timestamps: [...e.timestamps].sort(),
  }));
  log(`→ Found ${list.length} recoverable post URLs.`);
  return list;
}

/** Choose up to `max` snapshot timestamps to try, spread oldest→newest. */
function candidateTimestamps(timestamps, max = 4) {
  if (timestamps.length <= max) return timestamps;
  const picks = [timestamps[0]]; // oldest
  const step = (timestamps.length - 1) / (max - 1);
  for (let i = 1; i < max; i++) picks.push(timestamps[Math.round(i * step)]);
  return [...new Set(picks)];
}

// --------------------------------------------------------------------------
// Step 2 + 3 — fetch a snapshot and extract the post
// --------------------------------------------------------------------------
function meta(root, prop) {
  const el =
    root.querySelector(`meta[property="${prop}"]`) || root.querySelector(`meta[name="${prop}"]`);
  return el?.getAttribute("content")?.trim() || "";
}

/** Strip the Wayback toolbar + junk containers from a parsed document. */
function stripWayback(root) {
  const junk = [
    "#wm-ipp-base",
    "#wm-ipp",
    "#donato",
    "script",
    "style",
    "noscript",
    "iframe",
    ".sharedaddy",
    ".jp-relatedposts",
    ".post-navigation",
    ".nav-links",
    ".comments-area",
    "#comments",
    ".related-posts",
    ".yarpp-related",
    ".author-bio",
    "form",
  ];
  for (const sel of junk) root.querySelectorAll(sel).forEach((n) => n.remove());
}

/** Pick the main article body from a WordPress theme. */
function pickContent(root) {
  const selectors = [
    ".entry-content",
    ".post-content",
    "article .content",
    ".td-post-content",
    ".single-content",
    "article",
    "main",
  ];
  for (const sel of selectors) {
    const el = root.querySelector(sel);
    if (el && el.innerHTML && el.text.trim().length > 120) return el;
  }
  return null;
}

function cleanTitle(t) {
  return (t || "")
    .replace(/\s*[|\-–—]\s*TopHunt.*$/i, "")
    .replace(/\s*[|\-–—]\s*tophunt\.in.*$/i, "")
    .trim();
}

function toEpochMs(iso, fallbackTs) {
  if (iso) {
    const d = Date.parse(iso);
    if (!isNaN(d)) return d;
  }
  // fallback: Wayback timestamp YYYYMMDDhhmmss
  if (fallbackTs && /^\d{14}$/.test(fallbackTs)) {
    const y = fallbackTs.slice(0, 4),
      mo = fallbackTs.slice(4, 6),
      da = fallbackTs.slice(6, 8),
      h = fallbackTs.slice(8, 10),
      mi = fallbackTs.slice(10, 12),
      s = fallbackTs.slice(12, 14);
    const d = Date.parse(`${y}-${mo}-${da}T${h}:${mi}:${s}Z`);
    if (!isNaN(d)) return d;
  }
  return Date.now();
}

/** Derive a clean slug from the original permalink path. */
function slugFromUrl(url) {
  try {
    const u = new URL(url);
    const seg = u.pathname.replace(/\/+$/,"").split("/").filter(Boolean).pop() || "";
    return decodeURIComponent(seg).toLowerCase();
  } catch {
    return "";
  }
}

/** Fetch + parse a single snapshot timestamp. Returns a post or throws. */
async function parseSnapshot(url, timestamp) {
  const snapUrl = `https://web.archive.org/web/${timestamp}/${url}`;
  const res = await fetchRetry(snapUrl, {
    headers: { "User-Agent": "TopHuntArchiveImporter/1.0 (+https://tophunt.in)" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`snapshot ${res.status}`);
  const html = await res.text();
  const root = parse(html, { blockTextElements: { script: false, style: false } });

  const title = cleanTitle(
    meta(root, "og:title") || root.querySelector("title")?.text || root.querySelector("h1")?.text || "",
  );
  if (!title) throw new Error("no title");

  const excerpt = (meta(root, "og:description") || meta(root, "description") || "").slice(0, 400);
  let coverImageUrl = meta(root, "og:image") || "";
  const publishedAt = toEpochMs(
    meta(root, "article:published_time") ||
      root.querySelector("time[datetime]")?.getAttribute("datetime") ||
      "",
    timestamp,
  );
  const category = meta(root, "article:section") || null;
  const tagEls = root.querySelectorAll('meta[property="article:tag"]');
  const tags = tagEls.map((e) => e.getAttribute("content")).filter(Boolean).slice(0, 10);

  stripWayback(root);
  const contentEl = pickContent(root);
  const content = contentEl ? contentEl.innerHTML.trim() : "";
  if (!content || content.length < 60) throw new Error("no content");

  if (coverImageUrl.startsWith("//")) coverImageUrl = "https:" + coverImageUrl;

  return {
    title,
    slug: slugFromUrl(url) || undefined,
    excerpt: excerpt || null,
    content,
    coverImageUrl: coverImageUrl || null,
    category,
    tags,
    author: "TopHunt",
    status: "published",
    originalUrl: url.replace(/^http:/, "https:").replace(":80/", "/"),
    publishedAt,
  };
}

/** Try several snapshots (oldest-first) until one yields real content. */
async function importOne({ url, timestamps }) {
  const candidates = candidateTimestamps(timestamps);
  let lastErr = "no snapshots";
  for (const ts of candidates) {
    try {
      return await parseSnapshot(url, ts);
    } catch (e) {
      lastErr = e.message;
      if (DELAY) await sleep(DELAY);
    }
  }
  throw new Error(lastErr);
}

// --------------------------------------------------------------------------
// Step 4 — push a batch to the Worker
// --------------------------------------------------------------------------
async function pushBatch(posts) {
  if (DRY_RUN) return { created: posts.length, updated: 0, skipped: 0, dryRun: true };
  if (!WORKER_URL || !ADMIN_PROXY_SECRET) {
    throw new Error("Set WORKER_URL and ADMIN_PROXY_SECRET env vars (or use --dry-run).");
  }
  const res = await fetch(`${WORKER_URL}/admin/blog/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Secret": ADMIN_PROXY_SECRET },
    body: JSON.stringify({ posts }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`import failed ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

// simple worker-pool
async function mapPool(items, size, fn) {
  const results = [];
  let idx = 0;
  const workers = Array.from({ length: size }, async () => {
    while (idx < items.length) {
      const myIdx = idx++;
      try {
        results[myIdx] = await fn(items[myIdx], myIdx);
      } catch (e) {
        results[myIdx] = { __error: e.message, item: items[myIdx] };
      }
      if (DELAY) await sleep(DELAY);
    }
  });
  await Promise.all(workers);
  return results;
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------
async function main() {
  let snapshots = await fetchPostSnapshots();
  snapshots.sort((a, b) => a.url.localeCompare(b.url));
  if (OFFSET) snapshots = snapshots.slice(OFFSET);
  if (LIMIT) snapshots = snapshots.slice(0, LIMIT);

  if (URLS_ONLY) {
    snapshots.forEach((s) => log(s.timestamps[s.timestamps.length - 1], s.url));
    log(`\nTotal: ${snapshots.length}`);
    return;
  }

  log(`→ Importing ${snapshots.length} posts (concurrency=${CONCURRENCY}, batch=${BATCH}, dryRun=${DRY_RUN})`);

  const parsed = [];
  let ok = 0,
    failed = 0;
  const failures = [];

  const results = await mapPool(snapshots, CONCURRENCY, async (s, i) => {
    const r = await importOne(s);
    if ((i + 1) % 25 === 0) log(`   …parsed ${i + 1}/${snapshots.length}`);
    return r;
  });

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r && !r.__error) {
      parsed.push(r);
      ok++;
    } else {
      failed++;
      failures.push({ url: snapshots[i].url, error: r?.__error });
    }
  }

  log(`\n→ Parsed OK: ${ok}, failed: ${failed}`);

  if (OUT) {
    fs.writeFileSync(OUT, JSON.stringify(parsed, null, 2));
    log(`→ Wrote ${parsed.length} posts to ${OUT}`);
  }

  if (DRY_RUN) {
    log("\n--- DRY RUN sample (first 3) ---");
    for (const p of parsed.slice(0, 3)) {
      log({
        title: p.title,
        slug: p.slug,
        category: p.category,
        publishedAt: new Date(p.publishedAt).toISOString(),
        coverImageUrl: p.coverImageUrl,
        excerpt: p.excerpt?.slice(0, 120),
        contentChars: p.content.length,
        originalUrl: p.originalUrl,
      });
    }
    if (failures.length) log(`\n(${failures.length} failures, e.g.)`, failures.slice(0, 5));
    log("\nDry run complete — nothing was written to the database.");
    return;
  }

  // Push in batches.
  let created = 0,
    updated = 0,
    skipped = 0;
  for (let i = 0; i < parsed.length; i += BATCH) {
    const chunk = parsed.slice(i, i + BATCH);
    const r = await pushBatch(chunk);
    created += r.created || 0;
    updated += r.updated || 0;
    skipped += r.skipped || 0;
    log(`   pushed ${Math.min(i + BATCH, parsed.length)}/${parsed.length}  (created=${created}, updated=${updated})`);
  }

  log(`\n✅ Import done. created=${created}, updated=${updated}, skipped=${skipped}, parseFailed=${failed}`);
  if (failures.length) log(`   ${failures.length} URLs failed to parse (see above / rerun with --dry-run for detail).`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
