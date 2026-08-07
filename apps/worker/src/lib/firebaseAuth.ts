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

const JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const JWKS_KV_KEY = "firebase:jwks";

interface CachedJwks {
  keys: JSONWebKeySet;
  expiresAt: number;
}

async function getJwks(env: Env): Promise<JSONWebKeySet> {
  const cached = await env.CACHE_KV.get<CachedJwks>(JWKS_KV_KEY, "json");
  if (cached && cached.expiresAt > Date.now()) {
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

  await env.CACHE_KV.put(JWKS_KV_KEY, JSON.stringify(payload), {
    expirationTtl: Math.max(60, maxAge),
  });
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
