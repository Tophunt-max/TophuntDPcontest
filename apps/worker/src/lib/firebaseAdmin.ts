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
import { getFirebaseServiceAccount } from "./integrations";
import { memoGet, memoPut } from "./memo";

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

/**
 * The service account, resolved from the encrypted credential store first and the
 * environment second (lib/integrations.ts), so it can be rotated from the admin
 * panel without CLI access.
 */
async function getServiceAccount(env: Env): Promise<ServiceAccount> {
  const raw = await getFirebaseServiceAccount(env);
  if (!raw) throw httpsError("internal", "No Firebase service account is configured.");
  try {
    return JSON.parse(raw) as ServiceAccount;
  } catch {
    throw httpsError("internal", "The Firebase service account is malformed (expected the full JSON key file).");
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

/**
 * Safety margin: a token is treated as spent this long before it truly expires, so
 * an in-flight request cannot be the one that discovers it lapsed.
 */
const TOKEN_SKEW_MS = 30_000;

/**
 * Mint (and cache) a Google OAuth access token for the service account.
 *
 * ---------------------------------------------------------------------------
 * Why there is an isolate memo in front of the KV cache
 * ---------------------------------------------------------------------------
 * This function was an N+1 READ on the busiest write path in the app. Push delivery
 * (lib/notify.ts `deliverToTokens`) fans out over a user's devices with
 * `tokens.map(t => sendFcmToToken(...))`, and every `sendFcmToToken` called this —
 * so ONE notification to a three-device user spent three KV reads, six if the
 * transient-failure retry fired. `drainBroadcastJobs` then does that for a
 * PAGE_SIZE of 100 recipients per cron tick, i.e. several hundred KV reads to send
 * one broadcast page, all of them fetching the same string.
 *
 * The memo collapses that to one read per isolate per token lifetime.
 *
 * Why it is safe here, given lib/memo.ts forbids memoising anything consulted to
 * decide whether an action is ALLOWED: this is not such a value. It is an opaque
 * bearer token minted by Google with a self-describing expiry, and the memo TTL is
 * derived FROM that expiry (minus the same skew the KV check uses), so a memoised
 * token can never outlive the one KV would have handed back. Nothing revokes it
 * out-of-band that would not also invalidate the KV copy for up to an hour.
 */
export async function getAccessToken(env: Env): Promise<string> {
  const memoised = memoGet<string>(TOKEN_KV_KEY);
  if (memoised) return memoised;
  // A value cache alone does NOT fix the N+1, because the fan-out is CONCURRENT:
  // `Promise.all(tokens.map(...))` starts every call before any of them has finished
  // populating the memo, so all of them miss it and all of them read KV. Sharing the
  // in-flight promise is what actually collapses one notification's devices — and a
  // burst of simultaneous requests — into a single KV read and a single OAuth
  // exchange.
  //
  // A failed BORROW falls back to doing the work ourselves rather than propagating:
  // the shared promise lives in another request's I/O context, which `workerd`
  // restricts and which is cancelled if that request goes away first. Propagating it
  // would fail a push (or an admin user operation) for a reason that has nothing to do
  // with this request. See the fuller note in lib/firebaseAuth.ts `getJwks`.
  const shared = inflightToken;
  if (shared) {
    try {
      return await shared;
    } catch {
      /* borrow failed — mint our own below */
    }
  }

  const own = fetchAccessToken(env);
  inflightToken = own;
  try {
    return await own;
  } finally {
    // Cleared on failure too, so one transient error cannot poison the isolate — but
    // only if nothing newer has taken the slot.
    if (inflightToken === own) inflightToken = null;
  }
}

/** Shared in-flight token fetch for this isolate. See `getAccessToken`. */
let inflightToken: Promise<string> | null = null;

async function fetchAccessToken(env: Env): Promise<string> {
  const cached = await env.CACHE_KV.get<{ token: string; expiresAt: number }>(
    TOKEN_KV_KEY,
    "json",
  );
  if (cached && cached.expiresAt > Date.now() + TOKEN_SKEW_MS) {
    // Memoise only the remaining life, so the isolate copy expires no later than
    // the durable one it came from.
    memoPut(TOKEN_KV_KEY, cached.token, Math.floor((cached.expiresAt - TOKEN_SKEW_MS - Date.now()) / 1000));
    return cached.token;
  }

  const sa = await getServiceAccount(env);
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
  // Memoised before the KV write is even attempted: the token is already valid, and
  // the fan-out described above happens within a single request, so the isolate copy
  // is what actually absorbs it. This also means a Worker whose KV writes are
  // exhausted still only performs one OAuth exchange per isolate.
  memoPut(TOKEN_KV_KEY, json.access_token, Math.max(0, json.expires_in - 60));
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
    // Previously unmapped, so it surfaced as a raw 500 "internal". That was the
    // dead end a recycled phone number hit: the number is still attached to an
    // abandoned Firebase identity, and the new owner's signup failed with an
    // error that told neither them nor us anything.
    if (msg.includes("PHONE_NUMBER_EXISTS"))
      throw httpsError("already-exists", "Phone number already registered.");
    if (msg.includes("INVALID_PHONE_NUMBER"))
      throw httpsError("invalid-argument", "Enter a valid phone number.");
    if (msg.includes("EMAIL_NOT_FOUND") || msg.includes("USER_NOT_FOUND"))
      throw httpsError("not-found", "User not found.");
    throw httpsError("internal", msg);
  }
  return json;
}

export interface CreateUserInput {
  /** Optional for phone-only accounts created by the OTP sign-in flow. */
  email?: string;
  password?: string;
  /** E.164 phone number. Creating a phone-only account requires no password. */
  phone?: string;
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
    // Phone-only accounts are created by the OTP sign-in flow, which has already
    // proven the user controls the number.
    phoneNumber: input.phone || undefined,
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
  fields: {
    password?: string;
    email?: string;
    disabled?: boolean;
    /**
     * E.164 phone number.
     *
     * This parameter did not exist, which meant the phone number could never be
     * synced to the Firebase record — the app writes `users.phone` in D1 and
     * resolves phone sign-in from there, so the Firebase `phoneNumber` set at
     * signup was left pointing at the ORIGINAL number forever. That is not
     * cosmetic drift: the identifier stays reserved on the Firebase side, so when
     * the number is recycled its next real owner cannot sign up at all
     * (`accounts` returns PHONE_NUMBER_EXISTS), and a user who "removed" their
     * number still has it attached to an identity we hold.
     */
    phoneNumber?: string;
  },
): Promise<void> {
  await idToolkit(env, "accounts:update", {
    localId: uid,
    ...(fields.password ? { password: fields.password } : {}),
    ...(fields.email ? { email: fields.email } : {}),
    ...(fields.phoneNumber ? { phoneNumber: fields.phoneNumber } : {}),
    ...(fields.disabled !== undefined ? { disableUser: fields.disabled } : {}),
  });
}

export async function deleteAuthUser(env: Env, uid: string): Promise<void> {
  await idToolkit(env, "accounts:delete", { localId: uid });
}

/**
 * Invalidate every REFRESH token on the account.
 *
 * This is what the Admin SDK's `revokeRefreshTokens()` does under the hood: set
 * `validSince`, and Identity Toolkit stops honouring refresh tokens issued before it.
 *
 * Worth being precise about what it does NOT do, because the name suggests more than
 * it delivers. Already-issued ID tokens keep verifying until they expire — up to an
 * hour — because `verifyIdToken` here checks a signature against locally cached JWKS
 * and never asks Firebase anything. So this is the half that stops NEW tokens being
 * minted; the half that refuses the ones already in circulation is the D1 cutoff in
 * lib/sessionRevocation.ts. Neither is sufficient alone, which is why that module always
 * writes the cutoff first and treats this call as best-effort.
 *
 * `validSince` is in EPOCH SECONDS and is passed as a string, which is what the REST
 * API expects for its int64 fields.
 */
export async function revokeRefreshTokens(
  env: Env,
  uid: string,
  validSinceSec: number,
): Promise<void> {
  await idToolkit(env, "accounts:update", {
    localId: uid,
    validSince: String(Math.floor(validSinceSec)),
  });
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
export interface FcmSendOptions {
  /**
   * The recipient's real unread count, used for the iOS app-icon badge.
   *
   * This used to be hardcoded to `1`, which meant the iOS badge always showed 1
   * no matter how many notifications were waiting and never cleared correctly —
   * a classic "stuck badge" complaint. Pass the actual count.
   */
  badge?: number;
  /**
   * Groups replaceable notifications. Android uses `collapse_key`, iOS uses the
   * `apns-collapse-id` header; both make a new notification REPLACE the previous
   * one with the same id in the tray rather than stacking. This is what turns 100
   * likes into one updating notification instead of 100 alerts.
   */
  collapseKey?: string;
  /** Android channel id — lets users mute per category in OS settings. */
  androidChannelId?: string;
}

export async function sendFcmToToken(
  env: Env,
  token: string,
  notification: { title: string; body: string },
  data: Record<string, string>,
  options: FcmSendOptions = {},
): Promise<{ ok: boolean; invalid: boolean; retryable: boolean; status: number }> {
  const accessToken = await getAccessToken(env);
  const projectId = env.FIREBASE_PROJECT_ID;

  const android: Record<string, any> = {
    notification: {
      icon: "ic_notification",
      color: "#FF4D67",
      ...(options.androidChannelId ? { channel_id: options.androidChannelId } : {}),
    },
  };
  if (options.collapseKey) android.collapse_key = options.collapseKey;

  const apns: Record<string, any> = {
    payload: {
      aps: {
        sound: "default",
        // Only send a badge when we actually know the count — omitting the key
        // leaves the existing badge untouched, whereas sending a wrong number
        // corrupts it.
        ...(typeof options.badge === "number" ? { badge: options.badge } : {}),
      },
    },
  };
  if (options.collapseKey) apns.headers = { "apns-collapse-id": options.collapseKey.slice(0, 64) };

  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message: { token, notification, data, android, apns } }),
  });
  if (res.ok) return { ok: true, invalid: false, retryable: false, status: res.status };

  const json = await res.json<any>().catch(() => ({}));
  const status = json?.error?.details?.[0]?.errorCode || json?.error?.status || "";
  const invalid = status === "UNREGISTERED" || status === "INVALID_ARGUMENT";
  // 429/5xx and FCM's UNAVAILABLE/INTERNAL are transient — worth one retry.
  // A permanently invalid token is not.
  const retryable =
    !invalid && (res.status === 429 || res.status >= 500 || status === "UNAVAILABLE" || status === "INTERNAL");
  return { ok: false, invalid, retryable, status: res.status };
}


/**
 * Mint a Firebase CUSTOM TOKEN for `uid`.
 *
 * This is what lets the server complete a sign-in it has authenticated itself.
 * The phone-login flow needs it: the OTP is sent and verified by this Worker (via
 * whichever SMS gateway is configured), so at the end there is a proven phone
 * owner but no Firebase credential. A custom token bridges that gap — the client
 * calls `signInWithCustomToken` and gets a normal Firebase session.
 *
 * The alternative, Firebase's own client-side phone auth, required an
 * unmaintained reCAPTCHA package and a WebView dependency that is not installed,
 * and it bypassed our own OTP rate limiting entirely.
 *
 * A custom token is a JWT signed by the service account with a fixed audience.
 * Firebase enforces a maximum lifetime of one hour; 10 minutes is plenty for an
 * immediate sign-in and limits the damage if one leaks.
 */
export async function createCustomToken(
  env: Env,
  uid: string,
  claims?: Record<string, unknown>,
): Promise<string> {
  if (!uid) throw httpsError("invalid-argument", "uid is required to mint a token.");
  const sa = await getServiceAccount(env);
  const issuedAt = Math.floor(Date.now() / 1000);

  const header = { alg: "RS256", typ: "JWT" };
  const payload: Record<string, unknown> = {
    iss: sa.client_email,
    sub: sa.client_email,
    aud: "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit",
    iat: issuedAt,
    exp: issuedAt + 600,
    uid,
  };
  // Custom claims must be nested; top-level unknown keys are rejected.
  if (claims && Object.keys(claims).length > 0) payload.claims = claims;

  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
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
