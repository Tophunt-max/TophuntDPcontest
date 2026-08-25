/**
 * Public media must be cross-origin readable, or the web VS-card capture breaks.
 *
 * `/media/*` serves the entry images. On web the battle card is produced by
 * drawing those images to a canvas (html-to-image) and exporting it — which the
 * browser refuses if the image response did not permit the reading origin: the
 * canvas becomes "tainted" and export throws. The symptom is not an error the
 * user sees, it is the composite silently never being generated and the story
 * falling back to the live frame.
 *
 * So the header is load-bearing, and easy to lose to a well-meaning tightening of
 * CORS. These tests pin the contract: media says `*`, exposes the range/etag
 * headers a cross-origin player needs, and never asks for credentials (which `*`
 * forbids anyway).
 */
import { describe, it, expect } from "vitest";
import {
  MEDIA_EXPOSED_HEADERS,
  applyPublicMediaCors,
  preflightMediaCorsHeaders,
} from "../src/lib/mediaCors";

describe("applyPublicMediaCors", () => {
  it("makes the object readable from any origin", () => {
    const h = new Headers();
    applyPublicMediaCors(h);
    // `*`, not a reflected origin: these are immutable, edge-cached-for-a-year,
    // credential-free public bytes, so a single cache entry serves everyone.
    expect(h.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("exposes the headers a cross-origin media player needs", () => {
    const h = new Headers();
    applyPublicMediaCors(h);
    const exposed = h.get("Access-Control-Expose-Headers") || "";
    for (const name of MEDIA_EXPOSED_HEADERS) {
      expect(exposed).toContain(name);
    }
  });

  it("never combines `*` with credentials, which the spec forbids", () => {
    const h = new Headers();
    applyPublicMediaCors(h);
    // A wildcard origin plus Allow-Credentials is rejected by every browser, and
    // media needs no cookies — so this must stay absent.
    expect(h.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  it("overwrites rather than appends, so it is safe to call on a populated Headers", () => {
    const h = new Headers({ "Access-Control-Allow-Origin": "https://evil.example" });
    applyPublicMediaCors(h);
    expect(h.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("does not pin the response to an origin (no Vary: Origin), keeping the cache single-keyed", () => {
    const h = new Headers();
    applyPublicMediaCors(h);
    expect(h.get("Vary")).toBeNull();
  });
});

describe("preflightMediaCorsHeaders", () => {
  it("answers a preflight with the same public origin", () => {
    expect(preflightMediaCorsHeaders().get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("allows only read methods", () => {
    const methods = preflightMediaCorsHeaders().get("Access-Control-Allow-Methods") || "";
    expect(methods).toContain("GET");
    expect(methods).toContain("HEAD");
    expect(methods).toContain("OPTIONS");
    // Media is read-only over HTTP — writes go through the authenticated /upload
    // and /admin routes, never here.
    expect(methods).not.toContain("PUT");
    expect(methods).not.toContain("DELETE");
  });

  it("permits the Range header a media fetch may send", () => {
    expect(preflightMediaCorsHeaders().get("Access-Control-Allow-Headers")).toContain("Range");
  });

  it("lets the browser cache the preflight", () => {
    expect(Number(preflightMediaCorsHeaders().get("Access-Control-Max-Age"))).toBeGreaterThan(0);
  });
});
