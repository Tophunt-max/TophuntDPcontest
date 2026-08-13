import { Env } from "../types";
import { getDb, schema } from "../db";
import { eq, sql, inArray } from "drizzle-orm";
import { importOneUrl } from "./importer";
import { newId, now } from "./ids";

const PROGRESS_KEY = "blog:import:progress";
const DOMAIN = "tophunt.in";

async function uniqueBlogSlug(db: any, base: string, ignoreId?: string): Promise<string> {
  let slug = base;
  for (let i = 2; i < 500; i++) {
    const existing = await db.select({ id: schema.blogPosts.id }).from(schema.blogPosts).where(eq(schema.blogPosts.slug, slug)).get();
    if (!existing || existing.id === ignoreId) return slug;
    slug = `${base}-${i}`;
  }
  return `${base}-${Date.now()}`;
}

function slugify(input: string): string {
  return (input || "").toString().normalize("NFKC").toLowerCase().trim().replace(/['"]/g, "").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "post";
}

export async function discoverUrls(env: Env, mode: "fresh" | "resume" | "failed"): Promise<string[]> {
  const db = getDb(env);
  let urlsToProcess: string[] = [];

  if (mode === "failed") {
    const failed = await db.select({ url: schema.blogImportLog.url }).from(schema.blogImportLog).where(eq(schema.blogImportLog.status, "pending")).all();
    urlsToProcess = failed.map(r => r.url);
  } else {
    // Fetch URLs via CDX (simplified)
    const base = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(DOMAIN)}*&output=json&fl=original,statuscode,mimetype&filter=statuscode:200&filter=mimetype:text/html&limit=2000`;
    let resumeKey = "";
    const allRows: string[] = [];

    for (let page = 0; page < 5; page++) {
      let url = `${base}&showResumeKey=true`;
      if (resumeKey) url += `&resumeKey=${encodeURIComponent(resumeKey)}`;
      const res = await fetch(url, { headers: { "User-Agent": "TopHuntArchiveImporter/1.0" }});
      if (!res.ok) break;
      const chunk = (await res.json().catch(() => [])) as any[];
      if (chunk.length === 0) break;

      const start = page === 0 && chunk[0] && chunk[0][0] === "original" ? 1 : 0;
      let end = chunk.length;
      let nextKey = "";
      if (chunk.length >= 2 && Array.isArray(chunk[chunk.length - 1]) && chunk[chunk.length - 1].length === 1) {
        nextKey = chunk[chunk.length - 1][0];
        end = chunk.length - 1;
        while (end > start && Array.isArray(chunk[end - 1]) && chunk[end - 1].length === 0) end--;
      }
      for (let i = start; i < end; i++) {
        const u = chunk[i][0];
        if (u) allRows.push(u);
      }
      if (!nextKey) break;
      resumeKey = nextKey;
    }

    const byKey = new Map();
    const OWN_HOST = /(^|\.)tophunt\.in$/i;
    const EXCLUDE = /(\?|\/\.well-known|\/wp-|\/feed|\/category\/|\/tag\/|\/author\/|\/page\/|\/comments\/|\/amp\/$)/i;
    const ASSET_EXT = /\.(json|txt|xml|css|js|png|jpe?g|gif|svg|ico|webp|pdf|zip|mp4)$/i;

    for (const original of allRows) {
      let url = original.replace(/(%0[aAdD]|%20|\s)+$/g, "");
      let host = "";
      try { host = new URL(url.replace(/^https?:\/\//i, "https://").replace(":80/", "/")).hostname; } catch { continue; }
      if (!OWN_HOST.test(host)) continue;
      if (EXCLUDE.test(url) || ASSET_EXT.test(url)) continue;
      const path = url.replace(/^https?:\/\/[^/]+(:80)?/i, "");
      if (path === "" || path === "/") continue;
      const key = url.replace(/^https?:\/\//i, "").replace(":80/", "/").replace(/\/$/, "").toLowerCase();
      byKey.set(key, url);
    }
    urlsToProcess = [...byKey.values()];

    if (mode === "resume") {
      const doneRows = await db.select({ url: schema.blogImportLog.url }).from(schema.blogImportLog).where(sql`${schema.blogImportLog.status} IN ('imported','updated','duplicate','skipped')`).all();
      const doneSet = new Set(doneRows.map(r => r.url.replace(/^http:/, "https:").replace(":80/", "/").replace(/\/$/, "").toLowerCase()));
      urlsToProcess = urlsToProcess.filter(u => !doneSet.has(u.replace(/^http:/, "https:").replace(":80/", "/").replace(/\/$/, "").toLowerCase()));
    }
  }

  // Deduplicate
  return [...new Set(urlsToProcess)];
}

export async function processBatch(env: Env, urls: string[], state: any) {
  const db = getDb(env);

  const pushState = async (final = false) => {
    state.done = final;
    const mins = (Date.now() - state.startedAt) / 60000;
    state.speedPerMin = mins > 0 ? +(state.processed / mins).toFixed(1) : 0;
    await env.CACHE_KV.put(PROGRESS_KEY, JSON.stringify({ ...state, updatedAt: now() }), { expirationTtl: 86400 });
  };
  await pushState();

  const logRow = async (url: string, status: string, extra: any = {}) => {
    const ts = now();
    await db.insert(schema.blogImportLog).values({
      id: newId(),
      url,
      status,
      error: extra.error || null,
      postId: extra.postId || null,
      imagesTotal: extra.imagesTotal ?? 0,
      imagesMissing: extra.imagesMissing ?? 0,
      attempts: 1,
      createdAt: ts,
      updatedAt: ts,
    }).onConflictDoUpdate({
      target: schema.blogImportLog.url,
      set: {
        status,
        error: extra.error || null,
        postId: extra.postId || null,
        imagesTotal: extra.imagesTotal ?? 0,
        imagesMissing: extra.imagesMissing ?? 0,
        attempts: sql`${schema.blogImportLog.attempts} + 1`,
        updatedAt: ts,
      },
    });
  };

  for (const url of urls) {
    state.currentUrl = url;
    try {
      const p = await importOneUrl(url, env);

      const canonical = (p?.originalUrl || p?.canonicalUrl || "").trim();
      if (!p || !p.title || !p.content || String(p.content).trim().length < 40) {
        state.skipped++;
        if (canonical) await logRow(canonical, "skipped", { error: "empty or invalid page" });
      } else {
        let existing: any = null;
        if (canonical) existing = await db.select({ id: schema.blogPosts.id }).from(schema.blogPosts).where(eq(schema.blogPosts.originalUrl, canonical)).get();
        if (!existing && p.contentHash) {
          const dup = await db.select({ id: schema.blogPosts.id, originalUrl: schema.blogPosts.originalUrl }).from(schema.blogPosts).where(eq(schema.blogPosts.contentHash, p.contentHash)).get();
          if (dup && dup.originalUrl !== canonical) {
            state.duplicates++;
            if (canonical) await logRow(canonical, "duplicate", { postId: dup.id });
            existing = "dup";
          }
        }

        if (existing !== "dup") {
          const ts = now();
          const title = String(p.title).slice(0, 500);
          const excerpt = p.excerpt ? String(p.excerpt).slice(0, 500) : null;
          const metaTitle = (p.metaTitle || title).slice(0, 160);
          const metaDescription = (p.metaDescription || excerpt || String(p.content).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 155)).slice(0, 300);

          const values = {
            title, excerpt, content: p.content, coverImageUrl: p.coverImageUrl || null,
            category: p.category || null, tags: Array.isArray(p.tags) ? p.tags : [],
            author: p.author || "TopHunt", status: p.status || "published",
            metaTitle, metaDescription, canonicalUrl: canonical || null,
            source: "archive", originalUrl: canonical || null, contentHash: p.contentHash || null,
            publishedAt: typeof p.publishedAt === "number" ? p.publishedAt : null, updatedAt: ts,
          };
          const logExtra = { imagesTotal: p.imagesTotal ?? 0, imagesMissing: p.imagesMissing ?? 0 };

          if (existing) {
            await db.batch([
              db.update(schema.blogPosts).set(values).where(eq(schema.blogPosts.id, existing.id)),
            ]);
            await logRow(canonical, "updated", { postId: existing.id, ...logExtra });
            state.updated++;
          } else {
            const id = newId();
            const slug = await uniqueBlogSlug(db, slugify(p.slug || title));
            await db.batch([
              db.insert(schema.blogPosts).values({ id, slug, createdAt: ts, viewCount: 0, ...values }),
            ]);
            await logRow(canonical, "imported", { postId: id, ...logExtra });
            state.created++;
            state.imported++;
          }
        }
      }
    } catch (e: any) {
      state.failed++;
      await logRow(url, "failed", { error: e.message });
    }
    state.processed++;
    await pushState();
  }
  return state;
}
