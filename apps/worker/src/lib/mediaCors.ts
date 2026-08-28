/**
 * CORS for public media (`/media/*`), which is a different surface from the API
 * and needs a different policy.
 *
 * ---------------------------------------------------------------------------
 * Why media gets `*` while the API is origin-restricted
 * ---------------------------------------------------------------------------
 * The JSON API carries bearer tokens for wallets and payouts, so its CORS is
 * pinned to `ALLOWED_ORIGINS` — a page from an unknown origin must not be able to
 * make credentialed calls with the user's token.
 *
 * Media is the opposite: content-hash-addressed, immutable, unauthenticated
 * bytes that the app (on tophunt.in), the admin panel (on admin.tophunt.in) and
 * any share target legitimately load cross-origin. It is already fully public — a GET with
 * the URL returns the bytes to anyone, the only secret is the unguessable key —
 * so allowing cross-origin *reads* adds no exposure. What it enables is the thing
 * that was quietly broken: a `<canvas>`/`html-to-image` capture on web can only
 * read pixels from an image whose response permits the origin, otherwise the
 * canvas is "tainted" and export throws. Without `Access-Control-Allow-Origin`
 * the web VS-card capture silently failed and fell back to the live frame.
 *
 * `*` (not a reflected origin) is deliberate. These objects are cached at the
 * edge for a year; reflecting the request origin would force `Vary: Origin` and
 * fragment that cache per origin for no benefit, since the policy is identical
 * for everyone and no credentials are involved.
 *
 * This is intentionally NOT `Access-Control-Allow-Credentials`. `*` and
 * credentials are mutually exclusive by spec, and media needs no cookies.
 */

/**
 * Response headers a cross-origin reader may see. `Content-Range`/`Accept-Ranges`
 * are exposed so a media player doing ranged reads from another origin can still
 * discover the window and seek; `ETag` so it can revalidate.
 */
export const MEDIA_EXPOSED_HEADERS = ["Content-Length", "Content-Range", "Accept-Ranges", "ETag"] as const;

/**
 * Mark a media response as publicly readable cross-origin.
 *
 * Applied inside the media handler's `baseHeaders`, so the header is baked into
 * the object BEFORE it is stored in the edge cache — a cache hit therefore serves
 * it too, rather than depending on middleware re-running on every request.
 */
export function applyPublicMediaCors(headers: Headers): void {
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Expose-Headers", MEDIA_EXPOSED_HEADERS.join(", "));
}

/**
 * Headers for a preflight (`OPTIONS /media/*`).
 *
 * A plain `<img crossorigin>` or a simple GET fetch does not preflight, so this
 * is rarely hit — but a ranged cross-origin fetch can, and answering it
 * explicitly is cheaper than debugging why one browser refused. `Range` is listed
 * because that is the one non-simple header media requests carry.
 */
export function preflightMediaCorsHeaders(): Headers {
  const headers = new Headers();
  applyPublicMediaCors(headers);
  headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Range, Content-Type");
  headers.set("Access-Control-Max-Age", "86400");
  return headers;
}
