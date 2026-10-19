/**
 * Admin-managed sign-in / sign-up methods (`appConfig.authMethods`).
 *
 * One source of truth for three readers:
 *  - GET /read/app-config projects `resolveAuthMethods` so the app hides what is
 *    switched off (login AND signup screens, per platform);
 *  - the signup writers (routes/auth.ts `create` / `createProfile` /
 *    `phoneSignIn`, routes/api.ts profile fallback) call `assertSignupAllowed`,
 *    so a hidden button is not the only thing standing between a disabled
 *    provider and a new account;
 *  - admin POST /app-settings calls `validateAuthMethods` so nobody can save a
 *    configuration that locks every user out.
 *
 * Semantics an admin sees in the panel:
 *  - a method OFF (globally or for one platform) hides its button there and no
 *    NEW account can be created through it. Phone OTP is also refused for
 *    sign-in, because that one runs through our Worker. Google / Facebook /
 *    Apple / password sign-in itself happens inside Firebase, so an existing
 *    session keeps working — the button is simply gone.
 *  - `signupsEnabled: false` closes registration for every method; existing
 *    accounts sign in normally.
 */
import { httpsError } from "./http";

export const AUTH_METHOD_KEYS = ["google", "facebook", "apple", "phone", "password", "emailSignup"] as const;
export type AuthMethodKey = (typeof AUTH_METHOD_KEYS)[number];
/** The methods that SIGN IN an existing account (emailSignup only creates). */
export const LOGIN_METHOD_KEYS: AuthMethodKey[] = ["google", "facebook", "apple", "phone", "password"];
export const AUTH_PLATFORMS = ["web", "android", "ios"] as const;
export type AuthPlatform = (typeof AUTH_PLATFORMS)[number];

export interface MethodSwitch {
  enabled: boolean;
  web: boolean;
  android: boolean;
  ios: boolean;
}

export interface AuthMethods {
  signupsEnabled: boolean;
  signupsClosedMessage: string;
  google: MethodSwitch;
  facebook: MethodSwitch;
  apple: MethodSwitch;
  phone: MethodSwitch;
  password: MethodSwitch;
  emailSignup: MethodSwitch;
}

export const DEFAULT_SIGNUPS_CLOSED_MESSAGE = "Naye account abhi band hain. Jaldi wapas aayenge!";
const MAX_MESSAGE = 200;

const on = (): MethodSwitch => ({ enabled: true, web: true, android: true, ios: true });
const off = (): MethodSwitch => ({ enabled: false, web: true, android: true, ios: true });

function readSwitch(raw: unknown, fallback: MethodSwitch): MethodSwitch {
  if (typeof raw === "boolean") return { ...fallback, enabled: raw };
  if (!raw || typeof raw !== "object") return { ...fallback };
  const r = raw as Record<string, unknown>;
  const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
  return {
    enabled: bool(r.enabled, fallback.enabled),
    web: bool(r.web, fallback.web),
    android: bool(r.android, fallback.android),
    ios: bool(r.ios, fallback.ios),
  };
}

/**
 * The effective configuration. Rows saved before this existed fall back to the
 * legacy top-level flags (`googleLogin`, `appleLogin`, `facebookLogin`), so the
 * first deploy changes nothing an admin had already decided — Facebook stays off
 * where `facebookLogin` was never turned on. Apple is the exception (see below).
 */
export function resolveAuthMethods(cfg: any): AuthMethods {
  const raw = (cfg && typeof cfg.authMethods === "object" && cfg.authMethods) || {};
  const legacy = {
    google: cfg?.googleLogin === false ? off() : on(),
    // Opt-in until an admin saves `authMethods.apple`: the Apple provider has to
    // be enabled in the Firebase console first (until it is, every attempt fails
    // with auth/operation-not-allowed), so the legacy `appleLogin` default of
    // "on" advertised a button that could not work.
    apple: off(),
    facebook: cfg?.facebookLogin === true ? on() : off(),
  };
  const message =
    typeof raw.signupsClosedMessage === "string" && raw.signupsClosedMessage.trim()
      ? raw.signupsClosedMessage.trim().slice(0, MAX_MESSAGE)
      : DEFAULT_SIGNUPS_CLOSED_MESSAGE;
  return {
    signupsEnabled: raw.signupsEnabled !== false,
    signupsClosedMessage: message,
    google: readSwitch(raw.google, legacy.google),
    facebook: readSwitch(raw.facebook, legacy.facebook),
    apple: readSwitch(raw.apple, legacy.apple),
    phone: readSwitch(raw.phone, on()),
    password: readSwitch(raw.password, on()),
    emailSignup: readSwitch(raw.emailSignup, on()),
  };
}

/** Normalise a client-claimed platform; anything else is "unknown" (null). */
export function normalizePlatform(p: unknown): AuthPlatform | null {
  return typeof p === "string" && (AUTH_PLATFORMS as readonly string[]).includes(p) ? (p as AuthPlatform) : null;
}

/**
 * Is `key` usable on `platform`? With no (or an unknown) platform the method
 * counts as usable when it is on and allowed on at least one platform — the
 * platform is the client's claim, so the server's hard line is the global switch.
 */
export function methodAllowed(methods: AuthMethods, key: AuthMethodKey, platform?: AuthPlatform | null): boolean {
  const m = methods[key];
  if (!m?.enabled) return false;
  if (platform) return m[platform];
  return m.web || m.android || m.ios;
}

/** Firebase `sign_in_provider` claim -> the method that would create the account. */
export function signupMethodForProvider(signInProvider: string | null | undefined): AuthMethodKey | null {
  switch (signInProvider) {
    case "google.com":
      return "google";
    case "facebook.com":
      return "facebook";
    case "apple.com":
      return "apple";
    case "password":
      return "emailSignup";
    // Our only custom-token issuer is phone OTP (routes/auth.ts phoneSignIn).
    case "custom":
      return "phone";
    default:
      return null;
  }
}

const METHOD_LABEL: Record<AuthMethodKey, string> = {
  google: "Google",
  facebook: "Facebook",
  apple: "Apple",
  phone: "Phone",
  password: "Email & password",
  emailSignup: "Email",
};

/**
 * Throw unless a NEW account may be created through `method` on `platform`.
 * `method` null (an unrecognised provider) is held to the master switch only.
 */
export function assertSignupAllowed(methods: AuthMethods, method: AuthMethodKey | null, platform?: AuthPlatform | null): void {
  if (!methods.signupsEnabled) {
    throw httpsError("failed-precondition", methods.signupsClosedMessage);
  }
  if (method && !methodAllowed(methods, method, platform)) {
    throw httpsError(
      "failed-precondition",
      `${METHOD_LABEL[method]} se naya account abhi band hai. Koi aur tarika use karo.`,
    );
  }
}

/** Throw unless `method` may be used to SIGN IN on `platform` (phone OTP only). */
export function assertLoginAllowed(methods: AuthMethods, method: AuthMethodKey, platform?: AuthPlatform | null): void {
  if (!methodAllowed(methods, method, platform)) {
    throw httpsError("failed-precondition", `${METHOD_LABEL[method]} login abhi band hai. Koi aur tarika use karo.`);
  }
}

/**
 * Validate an admin patch for `authMethods` against the merged result.
 * Returns an error message, or null when acceptable.
 */
export function validateAuthMethods(patch: unknown, merged: any): string | null {
  if (patch === undefined) return null;
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return "authMethods must be an object.";
  const p = patch as Record<string, unknown>;
  for (const [k, v] of Object.entries(p)) {
    if (k === "signupsEnabled") {
      if (typeof v !== "boolean") return "signupsEnabled must be true or false.";
    } else if (k === "signupsClosedMessage") {
      if (typeof v !== "string") return "signupsClosedMessage must be text.";
      if (v.length > MAX_MESSAGE) return `signupsClosedMessage must be at most ${MAX_MESSAGE} characters.`;
    } else if ((AUTH_METHOD_KEYS as readonly string[]).includes(k)) {
      if (!v || typeof v !== "object" || Array.isArray(v)) return `${k} must be an object.`;
      for (const [sk, sv] of Object.entries(v as Record<string, unknown>)) {
        if (!["enabled", ...AUTH_PLATFORMS].includes(sk)) return `${k}.${sk} is not a known setting.`;
        if (typeof sv !== "boolean") return `${k}.${sk} must be true or false.`;
      }
    } else {
      return `authMethods.${k} is not a known setting.`;
    }
  }
  // Never let a save lock everyone out of a platform.
  const resolved = resolveAuthMethods(merged);
  for (const platform of AUTH_PLATFORMS) {
    if (!LOGIN_METHOD_KEYS.some((key) => methodAllowed(resolved, key, platform))) {
      return `At least one sign-in method must stay on for ${platform}.`;
    }
  }
  return null;
}

/**
 * The legacy `authSettings` shape that already-shipped app builds read
 * (`data.authSettings.googleLogin` …). Platform-agnostic: an old build does not
 * say which platform it is, so a method counts as on when it is on anywhere.
 */
export function legacyAuthSettings(methods: AuthMethods) {
  return {
    googleLogin: methodAllowed(methods, "google"),
    facebookLogin: methodAllowed(methods, "facebook"),
    appleLogin: methodAllowed(methods, "apple"),
    phoneLogin: methodAllowed(methods, "phone"),
    passwordLogin: methodAllowed(methods, "password"),
    emailSignup: methods.signupsEnabled && methodAllowed(methods, "emailSignup"),
  };
}
