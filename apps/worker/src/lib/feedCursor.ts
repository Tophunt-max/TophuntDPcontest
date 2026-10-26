/**
 * Paging cursor for the ranked For You / Following feeds.
 *
 * The ranked feed used to page with a bare offset into a per-viewer order that
 * lived 60 s in one isolate's memory. When the next page landed on another
 * isolate, after the 60 s, or after a block, mute, "Not interested" or weight
 * change (all part of the order key), the order was recomputed and the offset
 * pointed into a different list: battles repeated or were skipped. A recompute
 * also applies impression fatigue to the battles just shown, which moves them to
 * the bottom, so no position in the new order lines up with the old one.
 *
 * The cursor therefore carries WHAT was served, not where:
 *  - `t`: when the scroll session began (its first page). Battles created after
 *    that are left out of later pages, so new battles cannot push the list down
 *    under the reader; they appear on the next refresh;
 *  - `s`: a 24-bit fingerprint of every battle id served so far in the session
 *    (4 characters each). The next page is the top of the current order with
 *    those removed. Nothing repeats, and nothing is skipped: a battle that was
 *    not served is still in the list, wherever it now ranks.
 * A fingerprint collision (about 1 in 16 million per pair of ids) can only hide
 * one battle for the rest of that session.
 *
 * Format: `f2.<t base36>.<fingerprints>`. A bare number is still accepted as an
 * offset (older app builds and saved snapshots hold numeric cursors).
 */
export const SESSION_ORDER_TTL = 600;
/** Upper bound on ids remembered per session (the candidate pool is 190). */
export const MAX_SERVED = 250;
const PREFIX = "f2.";
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export type FeedCursor =
  /** Legacy offset into the order. */
  | { kind: "offset"; o: number }
  /** Session start + fingerprints of the ids already served. */
  | { kind: "served"; t: number; served: ReadonlySet<string> };

/** 24-bit FNV-1a of the id, as 4 url-safe characters. */
export function idFingerprint(id: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h = (h >>> 0) & 0xffffff;
  return B64[(h >> 18) & 63] + B64[(h >> 12) & 63] + B64[(h >> 6) & 63] + B64[h & 63];
}

function encode(t: number, served: Iterable<string>): string {
  return `${PREFIX}${t.toString(36)}.${[...served].join("")}`;
}

/** The cursor, or null for "first page". Never throws. */
export function decodeFeedCursor(raw: string | null | undefined): FeedCursor | null {
  if (raw == null || raw === "") return null;
  if (/^\d{1,6}$/.test(raw)) return { kind: "offset", o: Number(raw) };
  const m = /^f2\.([0-9a-z]{1,12})\.([A-Za-z0-9_-]*)$/.exec(raw);
  if (!m || m[2].length % 4 !== 0 || m[2].length > MAX_SERVED * 4) return null;
  const t = parseInt(m[1], 36);
  if (!Number.isFinite(t) || t <= 0) return null;
  const served = new Set<string>();
  for (let i = 0; i < m[2].length; i += 4) served.add(m[2].slice(i, i + 4));
  return { kind: "served", t, served };
}

/** Session start for this request: the cursor's, or now for a first page. */
export function sessionStartOf(cursor: FeedCursor | null, now: number): number {
  return cursor?.kind === "served" && cursor.t <= now ? cursor.t : now;
}

/** One page of `ids` and the cursor for the next one (null at the end). */
export function feedPage(
  ids: readonly string[],
  cursor: FeedCursor | null,
  limit: number,
  sessionStart: number,
): { ids: string[]; next: string | null } {
  if (cursor?.kind === "offset") {
    // Legacy: an old client's offset. The answer starts a fingerprinted session.
    const start = Math.min(Math.max(cursor.o, 0), ids.length);
    const page = ids.slice(start, start + limit);
    const served = ids.slice(0, start + page.length).map(idFingerprint);
    const more = start + page.length < ids.length;
    return { ids: page, next: page.length && more ? encode(sessionStart, served.slice(-MAX_SERVED)) : null };
  }
  const served = cursor?.kind === "served" ? cursor.served : new Set<string>();
  const remaining = ids.filter((id) => !served.has(idFingerprint(id)));
  const page = remaining.slice(0, limit);
  const all = new Set(served);
  for (const id of page) all.add(idFingerprint(id));
  const more = remaining.length > page.length && all.size < MAX_SERVED;
  return { ids: page, next: page.length && more ? encode(sessionStart, all) : null };
}
