import { parse } from "node-html-parser";
import { Env } from "../types";
import { getDb, schema } from "../db";
import { eq, sql } from "drizzle-orm";
import { newId, now } from "./ids";
import { putVerifiedImage } from "./r2";

const OWN_HOST = /(^|\.)tophunt\.in$/i;
const PHOTON_HOST = /(^|\.)wp\.com$/i;
const IGNORE_IMG = /(gravatar\.com|s\.w\.org|stats\.wp\.com|\.gif$|pixel|spacer|blank\.|archive\.org\/(?!web))/i;
const EXCLUDE = /(\?|\/\.well-known|\/wp-|\/feed|\/category\/|\/tag\/|\/author\/|\/page\/|\/comments\/|\/amp\/$)/i;
const ASSET_EXT = /\.(json|txt|xml|css|js|png|jpe?g|gif|svg|ico|webp|pdf|zip|mp4)$/i;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchRetry(url: string, init = {}, tries = 3) {
  let lastErr;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.status === 429 || (res.status >= 500 && res.status <= 599)) lastErr = new Error(`server ${res.status}`);
      else return res;
    } catch (e) {
      lastErr = e;
    }
    await sleep(500 * Math.pow(2, attempt));
  }
  throw lastErr || new Error("fetch failed");
}

function meta(root: any, prop: string) {
  const el = root.querySelector(`meta[property="${prop}"]`) || root.querySelector(`meta[name="${prop}"]`);
  return el?.getAttribute("content")?.trim() || "";
}

function stripWayback(root: any) {
  const junk = [
    "#wm-ipp-base", "#wm-ipp", "#donato", "#playback", "#wm-capinfo",
    "script", "style", "noscript", "iframe",
    ".sharedaddy", ".jp-relatedposts", ".post-navigation", ".nav-links",
    ".comments-area", "#comments", "#respond", ".comment-respond",
    ".related-posts", ".yarpp-related", ".author-bio", "form",
    ".wp-block-buttons", ".addtoany_share_save_container", ".code-block",
    ".adsbygoogle", "ins", ".sharedaddy", ".post-tags", ".entry-footer",
    ".at-above-post", ".at-below-post", ".at-above-post-recommended",
    ".at-below-post-recommended", ".addthis_tool", ".addthis_native_toolbox",
    ".addthis-smartlayers", ".a2a_kit", ".heateor_sss_sharing_container",
    ".sharethis-inline-share-buttons", ".social-share",
  ];
  for (const sel of junk) root.querySelectorAll(sel).forEach((n: any) => n.remove());
  root.querySelectorAll("*").forEach((n: any) => {
    const cls = (n.getAttribute?.("class") || "").toLowerCase();
    if (
      cls.includes("wm-ipp") || cls.includes("wb-autocomplete") ||
      cls.includes("addthis") || cls.includes("at-above") || cls.includes("at-below") ||
      cls.includes("sharedaddy") || cls.includes("a2a_")
    ) n.remove();
  });
}

function pickContent(root: any) {
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

function cleanTitle(t: string) {
  return (t || "")
    .replace(/\s*[|\-–—]\s*TopHunt.*$/i, "")
    .replace(/\s*[|\-–—]\s*tophunt\.in.*$/i, "")
    .replace(/\s*[|\-–—]\s*TOPHUNT.*$/i, "")
    .trim();
}

function jsonLdBlocks(rawHtml: string) {
  const blocks: any[] = [];
  const re = /<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(rawHtml))) {
    const raw = m[1].trim().replace(/https?:\/\/web\.archive\.org\/web\/\d{14}(?:[a-z]{2}_)?\//gi, "");
    try {
      const j = JSON.parse(raw);
      (Array.isArray(j) ? j : j["@graph"] || [j]).forEach((n: any) => n && blocks.push(n));
    } catch { }
  }
  return blocks;
}

function dateFromLd(lds: any[]) {
  for (const n of lds || []) {
    if (n && n.datePublished) {
      const d = Date.parse(n.datePublished);
      if (!isNaN(d)) return d;
    }
  }
  return null;
}

function scrubWayback(html: string) {
  return html
    .replace(/https?:\/\/web\.archive\.org\/web\/\d{14}(?:[a-z]{2}_)?\//gi, "")
    .replace(/\/\/web\.archive\.org\/web\/\d{14}(?:[a-z]{2}_)?\//gi, "//")
    .replace(/https?:\/\/web-static\.archive\.org[^"'()\s]*/gi, "")
    .replace(/\s+\n/g, "\n")
    .trim();
}

function extractDate(root: any) {
  const iso =
    meta(root, "article:published_time") ||
    root.querySelector("time[datetime]")?.getAttribute("datetime") ||
    root.querySelector('meta[itemprop="datePublished"]')?.getAttribute("content") ||
    "";
  if (iso) {
    const d = Date.parse(iso);
    if (!isNaN(d)) return d;
  }
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
    } catch { }
  }
  return null;
}

function extractCategory(root: any, lds: any[]) {
  for (const n of lds || []) {
    const t = n["@type"];
    const types = Array.isArray(t) ? t : [t];
    if (types.some((x: string) => ["Article", "BlogPosting", "NewsArticle"].includes(x))) {
      const s = Array.isArray(n.articleSection) ? n.articleSection[0] : n.articleSection;
      if (s && String(s).trim()) return String(s).trim();
    }
  }
  for (const n of lds || []) {
    if (n["@type"] === "BreadcrumbList" && Array.isArray(n.itemListElement) && n.itemListElement.length >= 2) {
      const items = [...n.itemListElement].sort((a, b) => (a.position || 0) - (b.position || 0));
      const cat = items[items.length - 2];
      const name = (cat?.name || cat?.item?.name || "").trim();
      if (name && !/^(home|tophunt|homepage)$/i.test(name)) return name;
    }
  }
  const section = meta(root, "article:section");
  if (section) return section;
  const link = root.querySelector(
    'a[rel="category tag"], .cat-links a, .post-categories a, .entry-meta a[href*="/category/"], .entry-header a[href*="/category/"]'
  );
  return link?.text?.trim() || null;
}

function extractTags(root: any) {
  const metas = root.querySelectorAll('meta[property="article:tag"]').map((e: any) => e.getAttribute("content"));
  if (metas.length) return metas.filter(Boolean).slice(0, 12);
  const links = root.querySelectorAll('a[rel="tag"]').map((e: any) => e.text?.trim());
  return links.filter(Boolean).slice(0, 12);
}

function normalizeForHash(html: string) {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

function originalFromWayback(u: string) {
  if (!u) return null;
  const m = u.match(/\/web\/\d{14}(?:[a-z]{2}_)?\/(.*)$/i);
  let orig = m ? m[1] : u;
  if (orig.startsWith("//")) orig = "https:" + orig;
  if (!/^https?:\/\//i.test(orig)) return null;
  return orig;
}

function waybackImageUrl(src: string, ts: string) {
  if (!src) return null;
  if (src.startsWith("//")) src = "https:" + src;
  if (src.startsWith("/web/")) return "https://web.archive.org" + src;
  if (/web\.archive\.org\/web\//i.test(src)) return src;
  if (/^https?:\/\//i.test(src)) return `https://web.archive.org/web/${ts}im_/${src}`;
  return null;
}

function isOwnImage(origUrl: string | null) {
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

// Media import logic inside worker
async function sha256Hex(input: string | ArrayBuffer): Promise<string> {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input as any);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Mirror one archived image into R2, or return null to leave the original URL in
 * place.
 *
 * The extension and the stored content type come from the bytes via
 * `putVerifiedImage`, not from the remote `Content-Type`. The old local `IMG_EXT`
 * map (a drifting duplicate of one in routes/admin.ts) accepted `image/svg+xml`
 * and fell back to `.img` for anything else, so an archive host could get a
 * scriptable SVG or an arbitrary blob written into our bucket and served from our
 * own media URL.
 *
 * Returning null on an unrecognised image is the right failure mode for a bulk
 * importer: the post still renders against the original remote URL and one odd
 * asset does not abort a run of hundreds.
 */
async function fetchToR2(url: string, env: Env) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "TopHuntArchiveImporter/1.0" }, redirect: "follow" });
    if (!res.ok) return null;
    const ct = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!ct.startsWith("image/")) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength < 100) return null;
    const hash = await sha256Hex(buf);
    const stored = await putVerifiedImage(env, "blog/imported", buf, hash);
    return stored?.publicUrl ?? null;
  } catch {
    return null;
  }
}

async function migrateContentImages(contentEl: any, ts: string, env: Env) {
  let total = 0, missing = 0;
  const imgs = contentEl.querySelectorAll("img");
  for (const img of imgs) {
    const raw = img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || img.getAttribute("src") || "";
    const orig = originalFromWayback(raw) || (/^https?:/i.test(raw) ? raw : null);
    if (!isOwnImage(orig)) {
      img.remove();
      continue;
    }
    total++;
    ["srcset", "data-src", "data-lazy-src", "data-srcset", "sizes", "loading"].forEach((a) => img.removeAttribute(a));
    const wb = waybackImageUrl(raw, ts) || waybackImageUrl(orig, ts);
    const r2 = wb ? await fetchToR2(wb, env) : null;
    if (r2) img.setAttribute("src", r2);
    else { missing++; img.remove(); }
  }
  return { total, missing };
}

async function migrateCover(ogImage: string | null, firstContentImgR2: string | null, ts: string, env: Env) {
  if (firstContentImgR2) return firstContentImgR2;
  if (!ogImage) return null;
  const orig = originalFromWayback(ogImage) || ogImage;
  if (!isOwnImage(orig)) return null;
  const wb = waybackImageUrl(ogImage, ts) || waybackImageUrl(orig, ts);
  return wb ? await fetchToR2(wb, env) : null;
}

function rewriteLinks(contentEl: any) {
  for (const a of contentEl.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href");
    const orig = originalFromWayback(href);
    if (orig) a.setAttribute("href", orig);
    else if (href.startsWith("/web/")) a.removeAttribute("href");
  }
}

function slugFromUrl(url: string) {
  try {
    const seg = new URL(url.replace(":80/", "/")).pathname.replace(/\/+$/, "").split("/").filter(Boolean).pop() || "";
    return decodeURIComponent(seg).toLowerCase();
  } catch {
    return "";
  }
}

export async function fetchTimestampsForUrl(url: string) {
  const clean = url.replace(/^https?:\/\//i, "").replace(":80/", "/");
  const targets = ["20240601", "20221001", "20200101"];
  const out = new Set<string>();
  for (const t of targets) {
    try {
      const res = await fetchRetry(
        `https://archive.org/wayback/available?url=${encodeURIComponent(clean)}&timestamp=${t}`,
        {},
        3
      );
      const j: any = await res.json().catch(() => ({}));
      const ts = j?.archived_snapshots?.closest?.timestamp;
      if (ts && j.archived_snapshots.closest.status === "200") out.add(ts);
    } catch { }
  }
  if (out.size) return [...out].sort();
  try {
    const res = await fetchRetry(
      `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(clean)}&output=json&fl=timestamp&filter=statuscode:200&collapse=timestamp:8`,
      {},
      2
    );
    if (res.ok) {
      const rows = (await res.json().catch(() => [])) as any[];
      return rows.slice(1).map((r) => r[0]).filter(Boolean).sort();
    }
  } catch { }
  return [];
}

async function fetchSnapshotHtml(url: string, timestamp: string) {
  const snapUrl = `https://web.archive.org/web/${timestamp}/${url}`;
  const res = await fetchRetry(snapUrl, { headers: { "User-Agent": "TopHuntArchiveImporter/1.0" }, redirect: "follow" });
  if (!res.ok) throw new Error(`snapshot ${res.status}`);
  return res.text();
}

export async function extractPost(html: string, url: string, timestamp: string, migrate: boolean, env: Env) {
  const root = parse(html, { blockTextElements: { script: false, style: false } });
  const lds = jsonLdBlocks(html);

  const title = cleanTitle(meta(root, "og:title") || root.querySelector("title")?.text || root.querySelector("h1")?.text || "");
  if (!title) throw new Error("no title");

  const ogImage = meta(root, "og:image");
  const publishedAt = extractDate(root) ?? dateFromLd(lds);
  const category = extractCategory(root, lds);
  const tags = extractTags(root);
  const metaDescription = (meta(root, "og:description") || meta(root, "description") || "").slice(0, 300);
  const ownCover = (() => {
    const co = originalFromWayback(ogImage) || ogImage;
    return isOwnImage(co);
  })();

  stripWayback(root);
  const contentEl = pickContent(root);
  if (!contentEl) throw new Error("no content element");

  rewriteLinks(contentEl);

  let imagesTotal = 0, imagesMissing = 0;
  if (migrate) {
    const r = await migrateContentImages(contentEl, timestamp, env);
    imagesTotal = r.total;
    imagesMissing = r.missing;
  } else {
    for (const img of contentEl.querySelectorAll("img")) {
      const raw = img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || img.getAttribute("src") || "";
      const orig = originalFromWayback(raw) || (/^https?:/i.test(raw) ? raw : null);
      if (isOwnImage(orig)) imagesTotal++;
      else img.remove();
    }
  }

  const content = scrubWayback(contentEl.innerHTML);
  const textLen = content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().length;
  if (!content || textLen < 80) throw new Error("no content");

  let coverImageUrl = null;
  if (migrate) {
    const firstImgR2 = contentEl.querySelector("img")?.getAttribute("src") || null;
    coverImageUrl = await migrateCover(ogImage, firstImgR2, timestamp, env);
  } else {
    coverImageUrl = ownCover ? "own-cover" : contentEl.querySelector("img") ? "content-img" : null;
  }

  const canonical = url.replace(/^http:/, "https:").replace(":80/", "/");
  const excerpt = metaDescription || content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  const contentHash = await sha256Hex(normalizeForHash(content));

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
    metaTitle: (meta(root, "og:title") ? cleanTitle(meta(root, "og:title")) : title).slice(0, 160),
    metaDescription: (metaDescription || excerpt).slice(0, 300),
    canonicalUrl: canonical,
    originalUrl: canonical,
    contentHash,
    publishedAt,
    imagesTotal,
    imagesMissing,
    _textLen: textLen,
  };
}

export async function importOneUrl(url: string, env: Env) {
  const timestamps = await fetchTimestampsForUrl(url);
  if (!timestamps.length) throw new Error("no snapshots (per-url cdx)");

  const picks = timestamps.length <= 4 ? timestamps : [timestamps[0], timestamps[Math.round((timestamps.length - 1)/3)], timestamps[Math.round((timestamps.length - 1)*2/3)], timestamps[timestamps.length-1]];
  const candidates = [...new Set(picks)].sort().reverse();

  const htmlCache = new Map();
  let best = null;
  let lastErr = "no snapshots";

  for (const ts of candidates) {
    try {
      const html = await fetchSnapshotHtml(url, ts);
      htmlCache.set(ts, html);
      const p = await extractPost(html, url, ts, false, env);
      const score = (p.coverImageUrl ? 5 : 0) + (p.publishedAt ? 3 : 0) + (p.category ? 3 : 0) + Math.min((p._textLen || 0) / 400, 10);
      if (!best || score > best.score) best = { ts, score };
      if (p.coverImageUrl && p.publishedAt && p.category && (p._textLen || 0) > 500) break;
    } catch (e: any) {
      lastErr = e.message;
    }
  }
  if (!best) throw new Error(lastErr);

  const html = htmlCache.get(best.ts) || (await fetchSnapshotHtml(url, best.ts));
  return await extractPost(html, url, best.ts, true, env);
}
