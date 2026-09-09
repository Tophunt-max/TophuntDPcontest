/**
 * Verifies Firebase ID tokens on the edge WITHOUT the Admin SDK.
 *
 * Firebase callable functions used to verify the caller's token automatically.
 * On Workers we do it explicitly: RS256 verification against Google's public
 * JWKS for the `securetoken@system` service account, checking iss/aud/exp.
 *
 * The JWKS is cached in KV (respecting the endpoint's max-age) so we don't
 * refetch on every request / cold isolate.
 */
import { jwtVerify, createLocalJWKSet, type JSONWebKeySet } from "jose";
import type { Env, AuthUser } from "../types";
import { httpsError } from "./http";
import { memoGet, memoPut } from "./memo";

const JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const JWKS_KV_KEY = "firebase:jwks";

interface CachedJwks {
  keys: JSONWebKeySet;
  expiresAt: number;
}

/**
 * Google's public keys, with an isolate memo in front of the KV cache.
 *
 * This is the hottest KV READ in the Worker: it runs for EVERY authenticated
 * request, on a value that changes roughly once a day. Keeping it in KV alone meant
 * one KV read per request forever — reads are the cheaper quota, but "once per
 * request" is the wrong order of magnitude for a value this static, and it sat on
 * the critical path of every sign-in.
 *
 * Safe to memoise for the same reason the access token is (see lib/firebaseAdmin.ts):
 * the memo TTL is derived from the expiry the endpoint itself advertised, so the
 * isolate copy can never outlive what KV would have returned. Note what this does
 * NOT do — it does not decide whether anyone is allowed anything. `jwtVerify` still
 * runs in full against these keys on every single request, and a token signed by a
 * rotated-out key fails verification whether the key set came from memory or not.
 */
async function getJwks(env: Env): Promise<JSONWebKeySet> {
  const memoised = memoGet<JSONWebKeySet>(JWKS_KV_KEY);
  if (memoised) return memoised;

  // Concurrent requests would each miss the memo and each read KV, so the in-flight
  // fetch is shared. On a cold isolate taking a burst of traffic that is the
  // difference between one KV read and one per request.
  //
  // The rejection path is NOT optional. The shared promise was created inside another
  // request's I/O context: `workerd` restricts using it from a different request, and
  // if the originating request is cancelled (client disconnect, or it simply returns
  // first) the pending subrequest is cancelled and this await rejects. Propagating that
  // would mean `verifyIdToken` throwing — a 401 on a perfectly valid token, caused by
  // an unrelated request going away. So a failed borrow falls back to doing the work
  // ourselves, at the cost of one extra KV read in a rare case, on the quota that was
  // never the scarce one.
  const shared = inflightJwks;
  if (shared) {
    try {
      return await shared;
    } catch {
      /* borrow failed — fetch our own below */
    }
  }

  const own = fetchJwks(env);
  inflightJwks = own;
  try {
    return await own;
  } finally {
    // Only clear if nothing newer has taken the slot.
    if (inflightJwks === own) inflightJwks = null;
  }
}

/** Shared in-flight key-set fetch for this isolate. See `getJwks`. */
let inflightJwks: Promise<JSONWebKeySet> | null = null;

async function fetchJwks(env: Env): Promise<JSONWebKeySet> {
  const cached = await env.CACHE_KV.get<CachedJwks>(JWKS_KV_KEY, "json");
  if (cached && cached.expiresAt > Date.now()) {
    memoPut(JWKS_KV_KEY, cached.keys, Math.floor((cached.expiresAt - Date.now()) / 1000));
    return cached.keys;
  }

  const res = await fetch(JWKS_URL);
  if (!res.ok) throw httpsError("internal", "Failed to fetch Firebase public keys.");
  const keys = (await res.json()) as JSONWebKeySet;

  // Respect Cache-Control max-age (Google rotates keys ~daily).
  const cacheControl = res.headers.get("cache-control") || "";
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
  const maxAge = maxAgeMatch ? parseInt(maxAgeMatch[1], 10) : 3600;
  const payload: CachedJwks = { keys, expiresAt: Date.now() + maxAge * 1000 };
  // Memoised regardless of whether the KV write below succeeds, so a Worker that
  // has exhausted its KV write quota still refetches these once per isolate rather
  // than once per authenticated request.
  memoPut(JWKS_KV_KEY, keys, maxAge);

  // Cache the keys, but NEVER let a KV write failure (e.g. the daily put()
  // quota being exhausted) break token verification — we already have the keys
  // in hand. A failed cache write just means we refetch on the next cold path.
  try {
    await env.CACHE_KV.put(JWKS_KV_KEY, JSON.stringify(payload), {
      expirationTtl: Math.max(60, maxAge),
    });
  } catch (e) {
    console.error("[firebaseAuth] JWKS cache write failed (continuing)", e);
  }
  return keys;
}

/**
 * Verify a Firebase ID token and return the authenticated user.
 * Throws ApiError('unauthenticated') on any failure.
 */
export async function verifyIdToken(token: string, env: Env): Promise<AuthUser> {
  const projectId = env.FIREBASE_PROJECT_ID;
  try {
    const jwks = createLocalJWKSet(await getJwks(env));
    const { payload } = await jwtVerify(token, jwks, {
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
    });

    const uid = (payload.sub || (payload.user_id as string)) as string;
    if (!uid) throw new Error("no uid in token");

    return {
      uid,
      email: payload.email as string | undefined,
      // custom claim set via Identity Toolkit (setAdminRole)
      role: (payload.role as string | undefined) ?? undefined,
      // Discarded until now, which meant the backend had no way to tell a session
      // signed in seconds ago from one signed in last month — so "prove it's you
      // before you delete the account" was not expressible. See lib/reauth.ts.
      authTime:
        typeof payload.auth_time === "number" ? (payload.auth_time as number) : undefined,
    };
  } catch {
    throw httpsError("unauthenticated", "Invalid or expired authentication token.");
  }
}

/** Extract a bearer token from the Authorization header. */
export function bearerToken(authHeader: string | undefined | null): string | null {
  if (!authHeader) return null;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}
