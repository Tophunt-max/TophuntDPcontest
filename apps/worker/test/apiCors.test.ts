/**
 * The credentialed API's CORS policy, and specifically that it survives an ERROR.
 *
 * `hono/cors` sets `Access-Control-Allow-Origin` after `await next()`, so a handler
 * that THROWS unwinds past that line and the header is never set. Every thrown
 * response — 401 from `requireAuth`, 403 from the `/admin` gate, 429 from the rate
 * limiter, any 500 — therefore reached the browser without it, and a browser will
 * not expose a cross-origin response that lacks one. The admin panel showed a bare
 * `TypeError: Failed to fetch` instead of the real status, which reads as a network
 * outage and sends you debugging the wrong thing.
 *
 * `src/index.ts` cannot be imported here (it registers Durable Objects that import
 * `cloudflare:workers`, unavailable in Node), which is exactly why the policy lives
 * in `lib/apiCors.ts` — the same reason `lib/mediaCors.ts` exists and is tested the
 * same way.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  API_ALLOWED_HEADERS,
  API_ALLOWED_METHODS,
  API_EXPOSED_HEADERS,
  allowedOrigins,
  applyApiCorsHeaders,
  isWildcardPolicy,
  resolveApiCorsOrigin,
} from "../src/lib/apiCors";

const PROD = { ALLOWED_ORIGINS: "https://tophunt.in,https://admin.tophunt.in" };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("allowedOrigins", () => {
  it("parses the configured list, trimming whitespace", () => {
    expect(allowedOrigins({ ALLOWED_ORIGINS: " https://a.test , https://b.test " })).toEqual([
      "https://a.test",
      "https://b.test",
    ]);
  });

  it("falls back to the wildcard but says so loudly", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(allowedOrigins({ ALLOWED_ORIGINS: undefined })).toEqual(["*"]);
    // An unset allow-list lets any site make credentialed calls. It must not be
    // silent — but it must also not hard-fail a working deployment.
    expect(err).toHaveBeenCalled();
  });

  it("recognises the wildcard policy", () => {
    expect(isWildcardPolicy(["*"])).toBe(true);
    expect(isWildcardPolicy(["https://a.test"])).toBe(false);
    // "*" alongside real origins is NOT a wildcard policy — the list wins.
    expect(isWildcardPolicy(["*", "https://a.test"])).toBe(false);
  });
});

describe("resolveApiCorsOrigin", () => {
  it("reflects an allowed origin", () => {
    expect(resolveApiCorsOrigin(PROD, "https://admin.tophunt.in")).toBe("https://admin.tophunt.in");
  });

  it("refuses an origin that is not on the list", () => {
    expect(resolveApiCorsOrigin(PROD, "https://evil.test")).toBeNull();
  });

  it("refuses when there is no Origin header, under a restricted policy", () => {
    // Same-origin and server-to-server calls send no Origin and need no header.
    expect(resolveApiCorsOrigin(PROD, undefined)).toBeNull();
  });

  it("answers the wildcard when nothing is configured", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(resolveApiCorsOrigin({ ALLOWED_ORIGINS: "" }, "https://anything.test")).toBe("*");
  });
});

describe("applyApiCorsHeaders — the error path", () => {
  it("attaches the reflected origin, Vary and the exposed headers", () => {
    const headers = new Headers();

    const applied = applyApiCorsHeaders(headers, PROD, "https://admin.tophunt.in");

    expect(applied).toBe(true);
    expect(headers.get("Access-Control-Allow-Origin")).toBe("https://admin.tophunt.in");
    // Without Vary, a shared cache can serve one origin's response to another.
    expect(headers.get("Vary")).toBe("Origin");
    for (const name of API_EXPOSED_HEADERS) {
      expect(headers.get("Access-Control-Expose-Headers")).toContain(name);
    }
  });

  it("adds nothing for a disallowed origin — omission is the denial", () => {
    const headers = new Headers();

    const applied = applyApiCorsHeaders(headers, PROD, "https://evil.test");

    expect(applied).toBe(false);
    expect(headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("does not send Vary with a wildcard, where it is meaningless", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const headers = new Headers();

    applyApiCorsHeaders(headers, { ALLOWED_ORIGINS: "" }, "https://anything.test");

    expect(headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(headers.get("Vary")).toBeNull();
  });

  /**
   * The header set on an error response must match what the happy-path middleware
   * would have produced — a 401 the browser can read but whose headers differ from
   * a 200's is its own confusing bug.
   */
  it("agrees with the middleware's own configuration", () => {
    const origins = allowedOrigins(PROD);
    expect(isWildcardPolicy(origins)).toBe(false);
    const headers = new Headers();
    applyApiCorsHeaders(headers, PROD, origins[0]);
    expect(headers.get("Access-Control-Allow-Origin")).toBe(origins[0]);
  });

  it("keeps PUT in the allowed methods (the admin panel saves config with it)", () => {
    expect([...API_ALLOWED_METHODS]).toContain("PUT");
    expect([...API_ALLOWED_METHODS]).toContain("PATCH");
    expect([...API_ALLOWED_HEADERS]).toContain("Authorization");
  });
});
