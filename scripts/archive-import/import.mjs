#!/usr/bin/env node
/**
 * TopHunt archive importer  (v2 — spec-compliant)
 * ================================================
 * Recovers the original tophunt.in WordPress posts from the Internet Archive
 * (Wayback Machine) and loads ONLY the original TopHunt content into the
 * TopHunt blog (Cloudflare Worker -> D1 + R2).
 *
 * Guarantees (per import spec):
 *   • Imports content ONLY from tophunt.in / www.tophunt.in. Nothing else.
 *   • Strips all Internet Archive banners, toolbars, timestamps, injected
 *     scripts and metadata. No Wayback URLs are ever stored.
 *   • Extracts title, body, images, category, tags and — only when it can be
 *     determined confidently — the original publish date (else NULL; never the
 *     Wayback capture date).
 *   • Original images are downloaded and re-uploaded to Cloudflare R2; content
 *     image URLs are replaced with the new R2 URLs, preserving original order.
 *   • Internal links are unwrapped from Wayback and rewritten to tophunt.in.
 *   • SEO is always present (meta title + meta description, derived if needed).
 *   • Skips empty / broken / duplicate pages (canonical URL + content hash).
 *   • Transactional, batched, resumable and retryable; reports live progress
 *     and a final summary to the admin dashboard.
 *
 * Usage
 *   npm install
 *   WORKER_URL=https://<worker> ADMIN_PROXY_SECRET=<secret> node import.mjs [flags]
 *
 * Flags
 *   --dry-run          Parse only; no image upload, no DB writes, no progress.
 *   --urls-only        Print recoverable post URLs and exit.
 *   --retry-failed     Re-process only URLs currently marked "failed".
 *   --fresh            Ignore resume state; process everything.
 *   --limit=N          Process only the first N posts.
 *   --offset=N         Skip the first N posts.
 *   --concurrency=N    Parallel page fetches (default 3).
 *   --batch=N          Posts per DB import call (default 20).
 *   --delay=ms         Delay between page fetches per worker (default 300).
 *   --out=file.json    Also write parsed posts to a JSON file.
 */

import { parse } from "node-html-parser";
import crypto from "node:crypto";
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
const RETRY_FAILED = has("--retry-failed");
const FRESH = has("--fresh");
const LIMIT = parseInt(val("limit", "0"), 10) || 0;
const OFFSET = parseInt(val("offset", "0"), 10) || 0;
const CONCURRENCY = parseInt(val("concurrency", "3"), 10) || 3;
const BATCH = parseInt(val("batch", "20"), 10) || 20;
const DELAY = parseInt(val("delay", "300"), 10) || 300;
const OUT = val("out", "");

const WORKER_URL = (process.env.WORKER_URL || "").replace(/\/$/, "");
const ADMIN_PROXY_SECRET = process.env.ADMIN_PROXY_SECRET || "";
const DOMAIN = process.env.ARCHIVE_DOMAIN || "tophunt.in";

// Hosts whose images count as "original TopHunt content".
const OWN_HOST = /(^|\.)tophunt\.in$/i;
// Jetpack/Photon CDN mirrors of tophunt.in images.
const PHOTON_HOST = /(^|\.)wp\.com$/i;
// Hosts to always ignore (avatars, emoji, trackers, archive UI).
const IGNORE_IMG = /(gravatar\.com|s\.w\.org|stats\.wp\.com|\.gif$|pixel|spacer|blank\.|archive\.org\/(?!web))/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

const EXCLUDE = /(\?|\/\.well-known|\/wp-|\/feed|\/category\/|\/tag\/|\/author\/|\/page\/|\/comments\/|\/amp\/$)/i;
const ASSET_EXT = /\.(json|txt|xml|css|js|png|jpe?g|gif|svg|ico|webp|pdf|zip|mp4)$/i;

// --------------------------------------------------------------------------
// HTTP with retry/backoff (archive.org rate-limits with 429/503)
// --------------------------------------------------------------------------
async function fetchRetry(url, init = {}, tries = 5) {
  let lastErr;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const res = await fetch(url, init);
      // Retry on archive.org rate-limits (429) and any gateway/server error
      // (500/502/503/504 — the unbounded CDX endpoint times out at 60s).
      if (res.status === 429 || (res.status >= 500 && res.status <= 599)) lastErr = new Error(`server ${res.status}`);
      else return res;
    } catch (e) {
      lastErr = e;
    }
    await sleep(1000 * Math.pow(2, attempt) + Math.random() * 500);
  }
  throw lastErr || new Error("fetch failed");
}

// --------------------------------------------------------------------------
// Worker API helpers
// --------------------------------------------------------------------------
function requireWorker() {
  if (!WORKER_URL || !ADMIN_PROXY_SECRET) {
    throw new Error("Set WORKER_URL and ADMIN_PROXY_SECRET env vars (or use --dry-run).");
  }
}
async function workerPost(path, body) {
  const res = await fetchRetry(`${WORKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Secret": ADMIN_PROXY_SECRET },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${JSON.stringify(json)}`);
  return json;
}
async function workerGet(path) {
  const res = await fetchRetry(`${WORKER_URL}${path}`, { headers: { "X-Admin-Secret": ADMIN_PROXY_SECRET } });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

// --------------------------------------------------------------------------
// Step 1 — collect the latest snapshot set of every real post permalink
// --------------------------------------------------------------------------
async function fetchPostSnapshots() {
  log("→ Querying Wayback CDX for", DOMAIN, "…");
  const base =
    `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(DOMAIN)}*` +
    `&output=json&fl=original,timestamp,statuscode,mimetype&filter=statuscode:200&filter=mimetype:text/html`;

  // The unbounded CDX query times out (504) for domains with many captures, so
  // page through it with limit + showResumeKey. Each page returns up to
  // CDX_PAGE rows followed by an empty row and a single resumeKey row.
  const CDX_PAGE = 1500;
  const rows = [];
  let resumeKey = "";
  let page = 0;
  for (;;) {
    let url = `${base}&limit=${CDX_PAGE}&showResumeKey=true`;
    if (resumeKey) url += `&resumeKey=${encodeURIComponent(resumeKey)}`;
    const res = await fetchRetry(url);
    if (!res.ok) throw new Error(`CDX request failed: ${res.status}`);
    const chunk = await res.json();
    if (!Array.isArray(chunk) || chunk.length === 0) break;

    // Strip the header row on the first page.
    const start = page === 0 && chunk[0] && chunk[0][0] === "original" ? 1 : 0;

    // The resumeKey (if any) is the last non-empty row, preceded by an empty row.
    let end = chunk.length;
    let nextKey = "";
    if (chunk.length >= 2 && Array.isArray(chunk[chunk.length - 1]) && chunk[chunk.length - 1].length === 1) {
      nextKey = chunk[chunk.length - 1][0];
      end = chunk.length - 1;
      while (end > start && Array.isArray(chunk[end - 1]) && chunk[end - 1].length === 0) end--; // drop blank separator
    }
    for (let i = start; i < end; i++) rows.push(chunk[i]);

    page++;
    log(`   …CDX page ${page}: +${end - start} rows (total ${rows.length})`);
    if (!nextKey) break;
    resumeKey = nextKey;
    await sleep(300); // be gentle with archive.org
  }

  const byKey = new Map();
  for (let i = 0; i < rows.length; i++) {
    let [original, timestamp] = rows[i];
    if (!original || original === "original") continue;
    original = original.replace(/(%0[aAdD]|%20|\s)+$/g, "");
    // Domain guard — only tophunt.in / www.tophunt.in.
    let host = "";
    try {
      host = new URL(original.replace(/^https?:\/\//i, "https://").replace(":80/", "/")).hostname;
    } catch {
      continue;
    }
    if (!OWN_HOST.test(host)) continue;
    if (EXCLUDE.test(original) || ASSET_EXT.test(original)) continue;
    const path = original.replace(/^https?:\/\/[^/]+(:80)?/i, "");
    if (path === "" || path === "/") continue;
    const key = original.replace(/^https?:\/\//i, "").replace(":80/", "/").replace(/\/$/, "").toLowerCase();
    let entry = byKey.get(key);
    if (!entry) {
      entry = { url: original, timestamps: new Set() };
      byKey.set(key, entry);
    }
    entry.timestamps.add(timestamp);
  }
  const list = [...byKey.values()].map((e) => ({ url: e.url, timestamps: [...e.timestamps].sort() }));
  log(`→ Found ${list.length} recoverable tophunt.in post URLs.`);
  return list;
}

function candidateTimestamps(timestamps, max = 4) {
  if (timestamps.length <= max) return timestamps;
  const picks = [timestamps[0]];
  const step = (timestamps.length - 1) / (max - 1);
  for (let i = 1; i < max; i++) picks.push(timestamps[Math.round(i * step)]);
  return [...new Set(picks)];
}

// --------------------------------------------------------------------------
// Extraction helpers
// --------------------------------------------------------------------------
function meta(root, prop) {
  const el = root.querySelector(`meta[property="${prop}"]`) || root.querySelector(`meta[name="${prop}"]`);
  return el?.getAttribute("content")?.trim() || "";
}

/** Remove the Wayback toolbar + injected junk + WP widgets that aren't content. */
function stripWayback(root) {
  const junk = [
    "#wm-ipp-base", "#wm-ipp", "#donato", "#playback", "#wm-capinfo",
    "script", "style", "noscript", "iframe",
    ".sharedaddy", ".jp-relatedposts", ".post-navigation", ".nav-links",
    ".comments-area", "#comments", "#respond", ".comment-respond",
    ".related-posts", ".yarpp-related", ".author-bio", "form",
    ".wp-block-buttons", ".addtoany_share_save_container", ".code-block",
    ".adsbygoogle", "ins", ".sharedaddy", ".post-tags", ".entry-footer",
  ];
  for (const sel of junk) root.querySelectorAll(sel).forEach((n) => n.remove());
  // Remove any leftover Wayback insert comments.
  root.querySelectorAll("*").forEach((n) => {
    const cls = (n.getAttribute?.("class") || "").toLowerCase();
    if (cls.includes("wm-ipp") || cls.includes("wb-autocomplete")) n.remove();
  });
}

function pickContent(root) {
  const selectors = [
    ".entry-content", ".post-content", ".td-post-content", ".single-content",
    "article .content", "article", "main .post", "main",
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
    .replace(/\s*[|\-–—]\s*TOPHUNT.*$/i, "")
    .trim();
}

/** Original publish date — confident sources only, else null. */
function extractDate(root) {
  const iso =
    meta(root, "article:published_time") ||
    root.querySelector("time[datetime]")?.getAttribute("datetime") ||
    root.querySelector('meta[itemprop="datePublished"]')?.getAttribute("content") ||
    "";
  if (iso) {
    const d = Date.parse(iso);
    if (!isNaN(d)) return d;
  }
  // JSON-LD datePublished.
  for (const s of root.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const j = JSON.parse(s.text);
      const arr = Array.isArray(j) ? j : j["@graph"] || [j];
      for (const node of arr) {
        if (node && node.datePublished) {
          const d = Date.parse(node.datePublished);
          if (!isNaN(d)) return d;
        }
      }
    } catch {
      /* ignore */
    }
  }
  return null; // never fall back to the Wayback capture date
}

function extractCategory(root) {
  const section = meta(root, "article:section");
  if (section) return section;
  const link = root.querySelector('a[rel="category tag"], .cat-links a, .post-categories a');
  return link?.text?.trim() || null;
}

function extractTags(root) {
  const metas = root.querySelectorAll('meta[property="article:tag"]').map((e) => e.getAttribute("content"));
  if (metas.length) return metas.filter(Boolean).slice(0, 12);
  const links = root.querySelectorAll('a[rel="tag"]').map((e) => e.text?.trim());
  return links.filter(Boolean).slice(0, 12);
}

function normalizeForHash(html) {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

// --------------------------------------------------------------------------
// Wayback URL helpers
// --------------------------------------------------------------------------
/** Extract the original (pre-archive) URL from a Wayback-wrapped URL. */
function originalFromWayback(u) {
  if (!u) return null;
  const m = u.match(/\/web\/\d{14}(?:[a-z]{2}_)?\/(.*)$/i);
  let orig = m ? m[1] : u;
  if (orig.startsWith("//")) orig = "https:" + orig;
  if (!/^https?:\/\//i.test(orig)) return null;
  return orig;
}

/** Build a Wayback-fetchable raw-image URL for a given src + snapshot ts. */
function waybackImageUrl(src, ts) {
  if (!src) return null;
  if (src.startsWith("//")) src = "https:" + src;
  if (src.startsWith("/web/")) return "https://web.archive.org" + src;
  if (/web\.archive\.org\/web\//i.test(src)) return src;
  if (/^https?:\/\//i.test(src)) return `https://web.archive.org/web/${ts}im_/${src}`;
  return null;
}

/** Is this image original TopHunt content (not an avatar/emoji/tracker/UI img)? */
function isOwnImage(origUrl) {
  if (!origUrl || IGNORE_IMG.test(origUrl)) return false;
  let host = "";
  try {
    host = new URL(origUrl).hostname;
  } catch {
    return false;
  }
  if (OWN_HOST.test(host)) return true;
  if (PHOTON_HOST.test(host) && /tophunt\.in\//i.test(origUrl)) return true;
  return false;
}

// --------------------------------------------------------------------------
// Image migration to R2 (real runs only)
// --------------------------------------------------------------------------
const r2Cache = new Map(); // waybackUrl -> R2 url (or null on failure)

async function imageToR2(waybackUrl) {
  if (r2Cache.has(waybackUrl)) return r2Cache.get(waybackUrl);
  try {
    const { url } = await workerPost("/admin/media/fetch-to-r2", { url: waybackUrl, folder: "blog/imported" });
    r2Cache.set(waybackUrl, url || null);
    return url || null;
  } catch {
    r2Cache.set(waybackUrl, null);
    return null;
  }
}

/**
 * Walk the content element in document order, migrate each original TopHunt
 * image to R2 and rewrite the <img src>. Returns { total, missing }.
 * In dry-run mode nothing is uploaded (images are counted only).
 */
async function migrateContentImages(contentEl, ts) {
  let total = 0,
    missing = 0;
  const imgs = contentEl.querySelectorAll("img");
  for (const img of imgs) {
    const raw =
      img.getAttribute("data-src") ||
      img.getAttribute("data-lazy-src") ||
      img.getAttribute("src") ||
      "";
    const orig = originalFromWayback(raw) || (/^https?:/i.test(raw) ? raw : null);
    if (!isOwnImage(orig)) {
      img.remove(); // drop avatars / emoji / trackers / external images
      continue;
    }
    total++;
    // Strip lazy-load + responsive attrs that would override our src.
    ["srcset", "data-src", "data-lazy-src", "data-srcset", "sizes", "loading"].forEach((a) => img.removeAttribute(a));
    if (DRY_RUN) {
      img.setAttribute("src", waybackImageUrl(raw, ts) || orig);
      continue;
    }
    const wb = waybackImageUrl(raw, ts) || waybackImageUrl(orig, ts);
    const r2 = wb ? await imageToR2(wb) : null;
    if (r2) img.setAttribute("src", r2);
    else {
      missing++;
      img.remove(); // couldn't recover -> don't leave a dead/Wayback URL
    }
  }
  return { total, missing };
}

/** Migrate the cover (og:image) to R2. Returns R2 url or null. */
async function migrateCover(ogImage, firstContentImgR2, ts) {
  if (firstContentImgR2) return firstContentImgR2; // reuse already-migrated image
  if (!ogImage) return null;
  const orig = originalFromWayback(ogImage) || ogImage;
  if (!isOwnImage(orig)) return null;
  if (DRY_RUN) return waybackImageUrl(ogImage, ts) || orig;
  const wb = waybackImageUrl(ogImage, ts) || waybackImageUrl(orig, ts);
  return wb ? await imageToR2(wb) : null;
}

/** Unwrap Wayback link wrappers; keep internal links on tophunt.in. */
function rewriteLinks(contentEl) {
  for (const a of contentEl.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href");
    const orig = originalFromWayback(href);
    if (orig) a.setAttribute("href", orig);
    else if (href.startsWith("/web/")) a.removeAttribute("href");
  }
}

// --------------------------------------------------------------------------
// Parse a single snapshot into a post (throws on invalid/broken page)
// --------------------------------------------------------------------------
async function parseSnapshot(url, timestamp) {
  const snapUrl = `https://web.archive.org/web/${timestamp}/${url}`;
  const res = await fetchRetry(snapUrl, {
    headers: { "User-Agent": "TopHuntArchiveImporter/1.0 (+https://tophunt.in)" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`snapshot ${res.status}`);
  const html = await res.text();
  const root = parse(html, { blockTextElements: { script: false, style: false } });

  const title = cleanTitle(meta(root, "og:title") || root.querySelector("title")?.text || root.querySelector("h1")?.text || "");
  if (!title) throw new Error("no title");

  // Read metadata/date BEFORE stripping scripts (JSON-LD lives in <script>).
  const ogImage = meta(root, "og:image");
  const publishedAt = extractDate(root);
  const category = extractCategory(root);
  const tags = extractTags(root);
  const metaDescription = (meta(root, "og:description") || meta(root, "description") || "").slice(0, 300);

  stripWayback(root);
  const contentEl = pickContent(root);
  if (!contentEl) throw new Error("no content element");

  rewriteLinks(contentEl);
  const { total: imagesTotal, missing: imagesMissing } = await migrateContentImages(contentEl, timestamp);

  const content = contentEl.innerHTML.replace(/\s+\n/g, "\n").trim();
  const textLen = content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().length;
  if (!content || textLen < 80) throw new Error("no content");

  // Cover: reuse first migrated content image if og:image is unusable.
  const firstImgR2 = contentEl.querySelector("img")?.getAttribute("src") || null;
  const coverImageUrl = await migrateCover(ogImage, DRY_RUN ? null : firstImgR2, timestamp);

  const canonical = url.replace(/^http:/, "https:").replace(":80/", "/");
  const excerpt = metaDescription || content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  const contentHash = crypto.createHash("sha256").update(normalizeForHash(content)).digest("hex");

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
    // SEO always present.
    metaTitle: (meta(root, "og:title") ? cleanTitle(meta(root, "og:title")) : title).slice(0, 160),
    metaDescription: (metaDescription || excerpt).slice(0, 300),
    canonicalUrl: canonical,
    originalUrl: canonical,
    contentHash,
    publishedAt, // may be null (never the Wayback date)
    imagesTotal,
    imagesMissing,
  };
}

function slugFromUrl(url) {
  try {
    const seg = new URL(url.replace(":80/", "/")).pathname.replace(/\/+$/, "").split("/").filter(Boolean).pop() || "";
    return decodeURIComponent(seg).toLowerCase();
  } catch {
    return "";
  }
}

/** Try several snapshots (oldest-first, healthy era) until one parses. */
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
// Progress reporting -> dashboard
// --------------------------------------------------------------------------
let lastProgressPush = 0;
async function pushProgress(state, force = false) {
  if (DRY_RUN) return;
  const t = Date.now();
  if (!force && t - lastProgressPush < 1500) return;
  lastProgressPush = t;
  try {
    await workerPost("/admin/blog/import/progress", state);
  } catch {
    /* progress is best-effort */
  }
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------
async function main() {
  let snapshots = await fetchPostSnapshots();
  snapshots.sort((a, b) => a.url.localeCompare(b.url));

  if (URLS_ONLY) {
    snapshots.forEach((s) => log(s.timestamps[s.timestamps.length - 1], s.url));
    log(`\nTotal: ${snapshots.length}`);
    return;
  }

  if (!DRY_RUN) requireWorker();

  // Retry-failed: process only URLs currently marked failed.
  if (RETRY_FAILED && !DRY_RUN) {
    const failed = await workerGet("/admin/blog/import/log?status=failed&limit=1000");
    const failedUrls = new Set(failed.map((r) => (r.url || "").replace(/\/$/, "").toLowerCase()));
    snapshots = snapshots.filter((s) => failedUrls.has(s.url.replace(/^https?:\/\//i, "").replace(":80/", "/").replace(/\/$/, "").toLowerCase()) || failedUrls.has(s.url.replace(/\/$/, "").toLowerCase()));
    log(`→ Retry mode: ${snapshots.length} previously-failed URLs.`);
  } else if (!FRESH && !DRY_RUN) {
    // Resume: skip URLs already handled.
    try {
      const { urls } = await workerGet("/admin/blog/import/done-urls");
      const done = new Set((urls || []).map((u) => (u || "").replace(/\/$/, "").toLowerCase()));
      const before = snapshots.length;
      snapshots = snapshots.filter((s) => !done.has(s.url.replace(/^http:/, "https:").replace(":80/", "/").replace(/\/$/, "").toLowerCase()));
      if (before !== snapshots.length) log(`→ Resume: skipping ${before - snapshots.length} already-imported URLs.`);
    } catch {
      /* first run, nothing to resume */
    }
  }

  if (OFFSET) snapshots = snapshots.slice(OFFSET);
  if (LIMIT) snapshots = snapshots.slice(0, LIMIT);

  const total = snapshots.length;
  log(`→ Importing ${total} posts (concurrency=${CONCURRENCY}, batch=${BATCH}, dryRun=${DRY_RUN})`);

  const startedAt = Date.now();
  const state = {
    startedAt,
    total,
    processed: 0,
    imported: 0,
    updated: 0,
    skipped: 0,
    duplicates: 0,
    failed: 0,
    missingImages: 0,
    currentUrl: "",
    speedPerMin: 0,
    done: false,
  };
  await pushProgress(state, true);

  const parsed = [];
  const outAll = [];
  let idx = 0;
  let pending = [];

  const flush = async () => {
    if (DRY_RUN || pending.length === 0) return;
    const chunk = pending;
    pending = [];
    const r = await workerPost("/admin/blog/import", { posts: chunk });
    state.imported += r.created || 0;
    state.updated += r.updated || 0;
    state.skipped += r.skipped || 0;
    state.duplicates += r.duplicates || 0;
    await pushProgress(state, true);
  };

  const worker = async () => {
    while (idx < snapshots.length) {
      const my = idx++;
      const s = snapshots[my];
      state.currentUrl = s.url;
      try {
        const post = await importOne(s);
        state.missingImages += post.imagesMissing || 0;
        parsed.push(post);
        if (OUT) outAll.push(post);
        pending.push(post);
        if (pending.length >= BATCH) await flush();
      } catch (e) {
        state.failed++;
        if (!DRY_RUN) {
          try {
            await workerPost("/admin/blog/import/fail", { url: s.url, error: e.message });
          } catch {
            /* ignore */
          }
        }
      }
      state.processed++;
      const mins = (Date.now() - startedAt) / 60000;
      state.speedPerMin = mins > 0 ? +(state.processed / mins).toFixed(1) : 0;
      if (state.processed % 10 === 0) log(`   …${state.processed}/${total}  (ok=${parsed.length}, failed=${state.failed}, ${state.speedPerMin}/min)`);
      await pushProgress(state);
      if (DELAY) await sleep(DELAY);
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  await flush();

  state.done = true;
  const mins = (Date.now() - startedAt) / 60000;
  state.speedPerMin = mins > 0 ? +(state.processed / mins).toFixed(1) : 0;
  await pushProgress(state, true);

  if (OUT) {
    fs.writeFileSync(OUT, JSON.stringify(outAll, null, 2));
    log(`→ Wrote ${outAll.length} posts to ${OUT}`);
  }

  log("\n================ SUMMARY ================");
  log(` Total pages found : ${total}`);
  log(` Parsed OK         : ${parsed.length}`);
  log(` Imported (new)    : ${state.imported}`);
  log(` Updated           : ${state.updated}`);
  log(` Skipped           : ${state.skipped}`);
  log(` Duplicates        : ${state.duplicates}`);
  log(` Failed            : ${state.failed}`);
  log(` Missing images    : ${state.missingImages}`);
  log("========================================");

  if (DRY_RUN) {
    log("\n--- DRY RUN sample (first 2) ---");
    for (const p of parsed.slice(0, 2)) {
      log({
        title: p.title,
        slug: p.slug,
        category: p.category,
        tags: p.tags,
        publishedAt: p.publishedAt ? new Date(p.publishedAt).toISOString() : null,
        coverImageUrl: p.coverImageUrl,
        metaTitle: p.metaTitle,
        metaDescription: p.metaDescription?.slice(0, 100),
        images: `${p.imagesTotal} (missing ${p.imagesMissing})`,
        contentChars: p.content.length,
        contentHash: p.contentHash.slice(0, 12),
        canonicalUrl: p.canonicalUrl,
      });
    }
    log("\nDry run complete — no images uploaded, nothing written to the database.");
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
