import { httpsError } from "./http";

/**
 * SSRF-safe outbound fetch for admin-triggered "import this URL" features.
 *
 * The archive importer legitimately fetches arbitrary public web images, so a
 * host allow-list is not workable. What we can do is refuse the targets that
 * make server-side request forgery useful:
 *
 *  - non-HTTP(S) schemes (`file:`, `gopher:`, `data:` …)
 *  - loopback / link-local / private / CGNAP / unique-local address literals,
 *    including the cloud metadata endpoints (169.254.169.254, fd00:ec2::254)
 *  - internal-only hostnames (`localhost`, `*.internal`, `*.local`, bare hosts)
 *  - credentials in the URL (`http://user:pass@host`), used to confuse parsers
 *  - non-standard ports, which on an internal network are the interesting ones
 *
 * Redirects are followed MANUALLY so that every hop is re-validated: a public
 * URL that 302s to `http://169.254.169.254/latest/meta-data/` is the classic
 * bypass and `redirect: "follow"` walks straight into it.
 */

const ALLOWED_PORTS = new Set(["", "80", "443"]);
const BLOCKED_HOSTNAMES = new Set(["localhost", "localhost.localdomain", "metadata", "metadata.google.internal"]);
const MAX_REDIRECTS = 3;

function isBlockedIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((p) => Number(p));
  if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return false;
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true; // IETF protocol assignments
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

function isBlockedIpv6(host: string): boolean {
  // URL hostnames keep IPv6 literals in brackets.
  const inner = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (!inner.includes(":")) return false;
  const lower = inner.toLowerCase();
  if (lower === "::" || lower === "::1") return true; // unspecified / loopback
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) {
    return true; // fe80::/10 link-local
  }
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7 unique-local
  if (lower.startsWith("ff")) return true; // multicast
  // IPv4-mapped (::ffff:169.254.169.254) — validate the embedded literal too.
  const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped && isBlockedIpv4(mapped[1])) return true;
  return false;
}

/** Throws unless `raw` is a public HTTP(S) URL that is safe to fetch server-side. */
export function assertPublicHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw httpsError("invalid-argument", "A valid absolute http(s) URL is required.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw httpsError("invalid-argument", "Only http and https URLs can be imported.");
  }
  if (url.username || url.password) {
    throw httpsError("invalid-argument", "URLs with embedded credentials are not allowed.");
  }
  if (!ALLOWED_PORTS.has(url.port)) {
    throw httpsError("invalid-argument", "Only the default http/https ports can be imported.");
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || BLOCKED_HOSTNAMES.has(host)) {
    throw httpsError("invalid-argument", "That host cannot be imported.");
  }
  // A hostname with no dot cannot be a public DNS name — it is an internal
  // short name (or a container/service alias).
  if (!host.includes(".") && !host.startsWith("[")) {
    throw httpsError("invalid-argument", "That host cannot be imported.");
  }
  if (host.endsWith(".internal") || host.endsWith(".local") || host.endsWith(".localhost")) {
    throw httpsError("invalid-argument", "That host cannot be imported.");
  }
  if (isBlockedIpv4(host) || isBlockedIpv6(host)) {
    throw httpsError("invalid-argument", "Private and link-local addresses cannot be imported.");
  }
  return url;
}

export interface SafeFetchResult {
  response: Response;
  finalUrl: string;
}

/**
 * Fetch a public URL, validating the target and every redirect hop.
 * `redirect: "manual"` is deliberate — see the module docblock.
 */
export async function safeFetch(
  raw: string,
  init: RequestInit = {},
  maxRedirects = MAX_REDIRECTS,
): Promise<SafeFetchResult> {
  let target = assertPublicHttpUrl(raw).toString();

  for (let hop = 0; hop <= maxRedirects; hop++) {
    let res: Response;
    try {
      res = await fetch(target, { ...init, redirect: "manual" });
    } catch (e: any) {
      throw httpsError("internal", `Failed to fetch ${target}: ${e?.message || "network error"}`);
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return { response: res, finalUrl: target };
      // Re-validate the hop — this is the check `redirect: "follow"` skips.
      const next = new URL(location, target).toString();
      assertPublicHttpUrl(next);
      target = next;
      continue;
    }
    return { response: res, finalUrl: target };
  }
  throw httpsError("invalid-argument", "Too many redirects while importing that URL.");
}

/** Convenience wrapper used by the media importer: fetch + verify it is an image. */
export async function fetchExternalImage(
  raw: string,
  userAgent: string,
  maxBytes: number,
): Promise<{ buffer: ArrayBuffer; contentType: string; finalUrl: string }> {
  const { response, finalUrl } = await safeFetch(raw, { headers: { "User-Agent": userAgent } });
  if (!response.ok) throw httpsError("not-found", `Image fetch returned ${response.status}`);

  const contentType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!contentType.startsWith("image/")) {
    throw httpsError("invalid-argument", `Not an image (content-type: ${contentType || "unknown"}).`);
  }
  // Trust the declared length when present, but still bound the actual read so a
  // lying or absent Content-Length cannot exhaust Worker memory.
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared && declared > maxBytes) {
    throw httpsError("invalid-argument", `Image is larger than the ${maxBytes}-byte import limit.`);
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > maxBytes) {
    throw httpsError("invalid-argument", `Image is larger than the ${maxBytes}-byte import limit.`);
  }
  if (buffer.byteLength < 100) throw httpsError("invalid-argument", "Image too small / empty.");
  return { buffer, contentType, finalUrl };
}
