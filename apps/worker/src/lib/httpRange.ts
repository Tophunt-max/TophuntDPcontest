/**
 * HTTP Range helpers for serving R2 objects.
 *
 * Why this exists: `/media/*` used to serve every object with a plain
 * `env.MEDIA.get(key)` and no `Accept-Ranges`, so video scrubbing did not work,
 * the whole file was refetched on every play, and iOS `AVPlayer` — which expects
 * range requests — behaved unreliably. See MEDIA_MIGRATION_PLAN.md §2.1.
 */

/** A byte range resolved against a known object size. */
export interface ResolvedRange {
  offset: number;
  length: number;
}

/**
 * Should this request be treated as ranged?
 *
 * Multi-range requests (`bytes=0-99,200-299`) require a multipart/byteranges
 * response, which we deliberately do not implement — RFC 7233 permits replying
 * with the full representation instead, so those are treated as un-ranged.
 */
export function isRangedRequest(rangeHeader: string | undefined | null): boolean {
  if (!rangeHeader) return false;
  if (!/^bytes=/i.test(rangeHeader.trim())) return false;
  if (rangeHeader.includes(",")) return false;
  return true;
}

/**
 * Normalize the `R2Range` that R2 echoes back into concrete offset/length.
 *
 * `R2Range` is a three-way union (`{offset,length?}`, `{offset?,length}`,
 * `{suffix}`) and R2 does not guarantee which shape it returns, so every branch
 * has to be handled. `size` must be the FULL object size — `R2Object.size`
 * stays the complete length even on a ranged `get`.
 */
export function resolveRange(range: R2Range | undefined, size: number): ResolvedRange | null {
  if (!range) return null;

  if ("suffix" in range) {
    const length = Math.min(Math.max(range.suffix, 0), size);
    return { offset: size - length, length };
  }

  const offset = Math.min(Math.max(range.offset ?? 0, 0), size);
  const requested = range.length ?? size - offset;
  const length = Math.min(Math.max(requested, 0), size - offset);
  return { offset, length };
}

/** `Content-Range` value for a 206 response. */
export function contentRangeHeader(part: ResolvedRange, size: number): string {
  // An empty range has no meaningful last-byte-pos; clamp so we never emit
  // "bytes 0--1/n".
  const last = part.length > 0 ? part.offset + part.length - 1 : part.offset;
  return `bytes ${part.offset}-${last}/${size}`;
}

/** `Content-Range` value for a 416 (Range Not Satisfiable) response. */
export function unsatisfiedRangeHeader(size: number): string {
  return `bytes */${size}`;
}
