/**
 * Explore page configuration (`appConfig.explore`), managed from the admin panel.
 *
 *   banners   promo carousel at the top of Explore: image, optional copy, a link
 *             (an in-app route like `/referral` or an https URL), an on/off switch
 *             and an optional schedule window.
 *   sections  which Explore sections show, and in what order.
 *
 * The public projection (`publicExploreConfig`) only ever contains banners that
 * are enabled and inside their window right now, and a complete, de-duplicated
 * section list — so a client never has to second-guess the admin's data.
 */
import { httpsError } from "./http";

export const EXPLORE_SECTIONS = [
  "banners",
  "quickActions",
  "trending",
  "endingSoon",
  "contests",
  "openBattles",
  "topCreators",
  "people",
  "grid",
] as const;
export type ExploreSectionKey = (typeof EXPLORE_SECTIONS)[number];

export const EXPLORE_MAX_BANNERS = 10;
const MAX_TEXT = 80;
const MAX_URL = 1000;

export interface ExploreBanner {
  id: string;
  imageUrl: string;
  title: string;
  subtitle: string;
  link: string;
  enabled: boolean;
  startsAt: number | null;
  endsAt: number | null;
}

export interface ExploreSection {
  key: ExploreSectionKey;
  enabled: boolean;
}

/** An in-app route (`/referral`, `/battle/abc`) or an https URL. Nothing else. */
export function isSafeExploreLink(link: string): boolean {
  if (!link) return true;
  if (link.startsWith("/")) return !link.startsWith("//") && !/[\s\\]/.test(link);
  try {
    const u = new URL(link);
    return u.protocol === "https:";
  } catch {
    return false;
  }
}

function isHttpsUrl(v: string): boolean {
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const ts = (v: unknown): number | null => {
  const n = Number(v);
  return v === null || v === undefined || v === "" || !Number.isFinite(n) || n <= 0 ? null : Math.floor(n);
};

/** Every section, in the admin's order, with any missing ones appended (enabled). */
export function normaliseSections(raw: unknown): ExploreSection[] {
  const out: ExploreSection[] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw)) {
    for (const s of raw) {
      const key = (s as any)?.key;
      if (!(EXPLORE_SECTIONS as readonly string[]).includes(key) || seen.has(key)) continue;
      seen.add(key);
      out.push({ key, enabled: (s as any)?.enabled !== false });
    }
  }
  for (const key of EXPLORE_SECTIONS) if (!seen.has(key)) out.push({ key, enabled: true });
  return out;
}

function parseBanner(b: any, i: number): ExploreBanner {
  return {
    id: str(b?.id, 64) || `banner-${i + 1}`,
    imageUrl: str(b?.imageUrl, MAX_URL),
    title: str(b?.title, MAX_TEXT),
    subtitle: str(b?.subtitle, MAX_TEXT),
    link: str(b?.link, MAX_URL),
    enabled: b?.enabled !== false,
    startsAt: ts(b?.startsAt),
    endsAt: ts(b?.endsAt),
  };
}

/** What the app receives (public app config). Never throws. */
export function publicExploreConfig(cfg: any, nowMs: number = Date.now()) {
  const src = cfg?.explore && typeof cfg.explore === "object" ? cfg.explore : {};
  const banners = (Array.isArray(src.banners) ? src.banners : [])
    .slice(0, EXPLORE_MAX_BANNERS)
    .map(parseBanner)
    .filter(
      (b: ExploreBanner) =>
        b.enabled &&
        isHttpsUrl(b.imageUrl) &&
        isSafeExploreLink(b.link) &&
        (b.startsAt == null || b.startsAt <= nowMs) &&
        (b.endsAt == null || b.endsAt > nowMs),
    )
    .map(({ enabled: _e, startsAt: _s, endsAt: _end, ...b }: ExploreBanner) => b);
  return { banners, sections: normaliseSections(src.sections) };
}

/** Admin-side validation of an `explore` patch (normalises in place). Throws on anything invalid. */
export function validateExplorePatch(p: any): void {
  const bad = (m: string): never => {
    throw httpsError("invalid-argument", m);
  };
  if (!p || typeof p !== "object" || Array.isArray(p)) bad("explore must be an object.");
  for (const k of Object.keys(p)) if (k !== "banners" && k !== "sections") bad(`Unknown Explore setting "${k}".`);

  if (p.banners !== undefined) {
    if (!Array.isArray(p.banners)) bad("Banners must be a list.");
    if (p.banners.length > EXPLORE_MAX_BANNERS) bad(`At most ${EXPLORE_MAX_BANNERS} banners.`);
    const ids = new Set<string>();
    p.banners = p.banners.map((raw: any, i: number) => {
      const n = i + 1;
      if (!raw || typeof raw !== "object") bad(`Banner ${n}: invalid.`);
      for (const k of ["title", "subtitle"]) {
        if (raw[k] !== undefined && typeof raw[k] !== "string") bad(`Banner ${n}: ${k} must be text.`);
        if (typeof raw[k] === "string" && raw[k].trim().length > MAX_TEXT) bad(`Banner ${n}: ${k} is longer than ${MAX_TEXT} characters.`);
      }
      if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") bad(`Banner ${n}: enabled must be true or false.`);
      const b = parseBanner(raw, i);
      if (!b.imageUrl || !isHttpsUrl(b.imageUrl)) bad(`Banner ${n}: an https image URL is required.`);
      if (!isSafeExploreLink(b.link)) bad(`Banner ${n}: the link must be an app path like /referral or an https URL.`);
      if (b.startsAt != null && b.endsAt != null && b.endsAt <= b.startsAt) bad(`Banner ${n}: the end must be after the start.`);
      if (ids.has(b.id)) b.id = `${b.id}-${n}`;
      ids.add(b.id);
      return b;
    });
  }

  if (p.sections !== undefined) {
    if (!Array.isArray(p.sections)) bad("Sections must be a list.");
    for (const s of p.sections) {
      if (!(EXPLORE_SECTIONS as readonly string[]).includes(s?.key)) bad(`Unknown Explore section "${s?.key}".`);
      if (s.enabled !== undefined && typeof s.enabled !== "boolean") bad(`Section ${s.key}: enabled must be true or false.`);
    }
    p.sections = normaliseSections(p.sections);
  }
}
