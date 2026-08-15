/**
 * Firebase Admin operations WITHOUT the Node Admin SDK (which doesn't run on
 * Workers). We mint an OAuth2 access token from the service account using Web
 * Crypto (RS256 JWT bearer grant) and call the Identity Toolkit REST API for
 * user management + custom claims, and FCM HTTP v1 for push.
 *
 * Auth stays 100% on Firebase — this module is how the Worker talks to it.
 */
import type { Env } from "../types";
import { httpsError } from "./http";

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
  project_id?: string;
}

const OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/identitytoolkit",
  "https://www.googleapis.com/auth/firebase.messaging",
].join(" ");

const TOKEN_KV_KEY = "firebase:access_token";

function getServiceAccount(env: Env): ServiceAccount {
  try {
    return JSON.parse(env.FIREBASE_SERVICE_ACCOUNT) as ServiceAccount;
  } catch {
    throw httpsError("internal", "FIREBASE_SERVICE_ACCOUNT is missing or malformed.");
  }
}

// --- Web Crypto helpers ---------------------------------------------------
function base64url(input: ArrayBuffer | string): string {
  const bytes =
    typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

async function signJwt(sa: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: sa.client_email,
    scope: OAUTH_SCOPES,
    aud: sa.token_uri || "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(sa.private_key.replace(/\\n/g, "\n")),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${base64url(sig)}`;
}

/** Mint (and cache) a Google OAuth access token for the service account. */
export async function getAccessToken(env: Env): Promise<string> {
  const cached = await env.CACHE_KV.get<{ token: string; expiresAt: number }>(
    TOKEN_KV_KEY,
    "json",
  );
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;

  const sa = getServiceAccount(env);
  const assertion = await signJwt(sa);
  const res = await fetch(sa.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!res.ok) throw httpsError("internal", `OAuth token exchange failed: ${await res.text()}`);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  const expiresAt = Date.now() + json.expires_in * 1000;
  // Cache the access token, but never let a KV write failure (e.g. the daily
  // put() quota being exhausted) break admin/Identity-Toolkit operations — we
  // already minted a valid token. A failed cache write just costs one extra
  // OAuth exchange on the next cold path.
  try {
    await env.CACHE_KV.put(TOKEN_KV_KEY, JSON.stringify({ token: json.access_token, expiresAt }), {
      expirationTtl: Math.max(60, json.expires_in - 60),
    });
  } catch (e) {
    console.error("[firebaseAdmin] access-token cache write failed (continuing)", e);
  }
  return json.access_token;
}

// --- Identity Toolkit REST -------------------------------------------------
async function idToolkit(env: Env, path: string, body: unknown): Promise<any> {
  const token = await getAccessToken(env);
  const projectId = env.FIREBASE_PROJECT_ID;
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/projects/${projectId}/${path}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const json = await res.json<any>();
  if (!res.ok) {
    const msg = json?.error?.message || "Identity Toolkit request failed";
    if (msg.includes("EMAIL_EXISTS")) throw httpsError("already-exists", "Email already registered.");
    if (msg.includes("EMAIL_NOT_FOUND") || msg.includes("USER_NOT_FOUND"))
      throw httpsError("not-found", "User not found.");
    throw httpsError("internal", msg);
  }
  return json;
}

export interface CreateUserInput {
  email: string;
  password: string;
  displayName?: string;
  photoUrl?: string | null;
}

/** Create a Firebase Auth user. Returns the uid (localId). */
export async function createAuthUser(env: Env, input: CreateUserInput): Promise<string> {
  const json = await idToolkit(env, "accounts", {
    email: input.email,
    password: input.password,
    displayName: input.displayName,
    photoUrl: input.photoUrl || undefined,
  });
  return json.localId as string;
}

/** Look up a user by email; returns uid or null. */
export async function getUserByEmail(env: Env, email: string): Promise<string | null> {
  const token = await getAccessToken(env);
  const projectId = env.FIREBASE_PROJECT_ID;
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/projects/${projectId}/accounts:lookup`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ email: [email] }),
    },
  );
  const json = await res.json<any>();
  if (!res.ok) return null;
  return json.users?.[0]?.localId ?? null;
}

export async function updateAuthUser(
  env: Env,
  uid: string,
  fields: { password?: string; email?: string; disabled?: boolean },
): Promise<void> {
  await idToolkit(env, "accounts:update", {
    localId: uid,
    ...(fields.password ? { password: fields.password } : {}),
    ...(fields.email ? { email: fields.email } : {}),
    ...(fields.disabled !== undefined ? { disableUser: fields.disabled } : {}),
  });
}

export async function deleteAuthUser(env: Env, uid: string): Promise<void> {
  await idToolkit(env, "accounts:delete", { localId: uid });
}

/** Set custom claims (e.g. { role: 'admin' }) — merges by replacing the map. */
export async function setCustomClaims(
  env: Env,
  uid: string,
  claims: Record<string, unknown>,
): Promise<void> {
  await idToolkit(env, "accounts:update", {
    localId: uid,
    customAttributes: JSON.stringify(claims),
  });
}

// --- FCM HTTP v1 -----------------------------------------------------------
export async function sendFcmToToken(
  env: Env,
  token: string,
  notification: { title: string; body: string },
  data: Record<string, string>,
): Promise<{ ok: boolean; invalid: boolean }> {
  const accessToken = await getAccessToken(env);
  const projectId = env.FIREBASE_PROJECT_ID;
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        token,
        notification,
        data,
        android: { notification: { icon: "ic_notification", color: "#FF4D67" } },
        apns: { payload: { aps: { sound: "default", badge: 1 } } },
      },
    }),
  });
  if (res.ok) return { ok: true, invalid: false };
  const json = await res.json<any>().catch(() => ({}));
  const status = json?.error?.details?.[0]?.errorCode || json?.error?.status || "";
  const invalid = status === "UNREGISTERED" || status === "INVALID_ARGUMENT";
  return { ok: false, invalid };
}
