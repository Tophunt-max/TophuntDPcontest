/**
 * Which sign-in / sign-up methods this app build may OFFER right now.
 *
 * The admin switches live in `appConfig.authMethods` (Worker lib/authMethods.ts,
 * projected by GET /read/app-config). Pure so the login screen, the signup screen
 * and the social flow cannot disagree. The Worker enforces the same switches on
 * every account-creating path; this only decides what is shown.
 */

export type ClientPlatform = 'web' | 'android' | 'ios';
export type AuthMethodKey = 'google' | 'facebook' | 'apple' | 'phone' | 'password' | 'emailSignup';

export interface ClientAuthMethods {
  google: boolean;
  facebook: boolean;
  apple: boolean;
  phone: boolean;
  /** "Sign in with password". */
  password: boolean;
  /** Creating a NEW account with email + password. */
  emailSignup: boolean;
  /** Registration open at all (any method). */
  signupsOpen: boolean;
  signupsClosedMessage: string;
}

export const DEFAULT_SIGNUPS_CLOSED_MESSAGE = 'Naye account abhi band hain. Jaldi wapas aayenge!';

/**
 * Used before the config has ever loaded (first launch, offline). Mirrors the
 * Worker's defaults: Facebook and Apple are opt-in until an admin switches them
 * on, everything else is on. Permissive on purpose — a fetch failure must never
 * lock people out; the server still refuses what is really off.
 */
export const FALLBACK_AUTH_METHODS: ClientAuthMethods = {
  google: true,
  facebook: false,
  apple: false,
  phone: true,
  password: true,
  emailSignup: true,
  signupsOpen: true,
  signupsClosedMessage: DEFAULT_SIGNUPS_CLOSED_MESSAGE,
};

function switchOn(raw: any, platform: ClientPlatform): boolean | null {
  if (typeof raw === 'boolean') return raw;
  if (!raw || typeof raw !== 'object') return null;
  if (raw.enabled === false) return false;
  return raw[platform] !== false;
}

export function resolveClientAuthMethods(config: any, platform: ClientPlatform): ClientAuthMethods {
  if (!config || typeof config !== 'object') return { ...FALLBACK_AUTH_METHODS };
  const m = config.authMethods;
  if (m && typeof m === 'object') {
    const pick = (key: AuthMethodKey) => switchOn(m[key], platform) ?? FALLBACK_AUTH_METHODS[key];
    return {
      google: pick('google'),
      facebook: pick('facebook'),
      apple: pick('apple'),
      phone: pick('phone'),
      password: pick('password'),
      emailSignup: pick('emailSignup'),
      signupsOpen: m.signupsEnabled !== false,
      signupsClosedMessage:
        typeof m.signupsClosedMessage === 'string' && m.signupsClosedMessage.trim()
          ? m.signupsClosedMessage.trim()
          : DEFAULT_SIGNUPS_CLOSED_MESSAGE,
    };
  }
  // An older Worker: the legacy flags.
  const a = config.authSettings || {};
  const flag = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
  return {
    google: flag(a.googleLogin ?? config.googleLogin, true),
    facebook: flag(a.facebookLogin ?? config.facebookLogin, false),
    apple: flag(a.appleLogin ?? config.appleLogin, false),
    phone: flag(a.phoneLogin, true),
    password: flag(a.passwordLogin, true),
    emailSignup: flag(a.emailSignup, true),
    signupsOpen: true,
    signupsClosedMessage: DEFAULT_SIGNUPS_CLOSED_MESSAGE,
  };
}

/** Firebase `providerId` of a fresh credential -> the switch that creates accounts with it. */
export function signupKeyForProvider(providerId: string | null | undefined): AuthMethodKey | null {
  switch (providerId) {
    case 'google.com':
      return 'google';
    case 'facebook.com':
      return 'facebook';
    case 'apple.com':
      return 'apple';
    case 'password':
      return 'emailSignup';
    case 'phone':
    case 'custom':
      return 'phone';
    default:
      return null;
  }
}

/** Null when a NEW account may be created with `key`, else the message to show. */
export function signupBlockedReason(methods: ClientAuthMethods, key: AuthMethodKey | null): string | null {
  if (!methods.signupsOpen) return methods.signupsClosedMessage;
  if (key && !methods[key]) return 'Is tarike se naya account abhi band hai. Koi aur tarika use karo.';
  return null;
}
