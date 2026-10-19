import {
  FacebookAuthProvider,
  GoogleAuthProvider,
  OAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signInWithCredential,
  browserPopupRedirectResolver,
  getAuth,
  signOut,
  type UserCredential,
} from 'firebase/auth';
import { Platform } from 'react-native';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as AuthSession from 'expo-auth-session';
import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';
import app from '../firebase/initFirebase';
import { readApi } from '../api';
import { useSignupStore } from '../../store/signup';
import { isProfileComplete, markOnboardingComplete, markOnboardingIncomplete, onboardingDraftFor } from '@/src/lib/profileCompletion';
import { reportError } from '@/src/lib/reportError';
import { postAuthDestination } from '@/src/lib/postAuthRedirect';
import { friendlyAuthError, isAuthCancellation } from '@/src/lib/authErrors';
import { signupBlockedReason, signupKeyForProvider, type ClientAuthMethods } from '@/src/lib/authMethods';
import { isSameSiteAuth } from '@/src/lib/authDomain';
import { detectInAppBrowser } from '@/src/lib/inAppBrowser';
import { rememberAuthMethod } from '@/src/lib/lastAuthMethod';

type ProviderName = 'Google' | 'Apple' | 'Facebook';
const PROVIDER_ID: Record<ProviderName, string> = { Google: 'google.com', Apple: 'apple.com', Facebook: 'facebook.com' };

/** Options every entry point accepts. */
export interface SocialLoginOptions {
  /** The admin's switches, so a closed signup is caught before the profile form. */
  methods?: ClientAuthMethods;
}

/**
 * Social sign-in.
 *
 * This used to call `signInWithPopup`, a WEB-ONLY Firebase API, and then bail out
 * with an info toast on iOS/Android — so all three buttons were decorative in the
 * actual app. `expo-auth-session` and `expo-apple-authentication` were already
 * installed and never imported.
 *
 * Now:
 *  - WEB keeps the popup flow (it works and needs no native config).
 *  - NATIVE uses the platform-correct flow and exchanges the resulting OAuth
 *    credential for a Firebase session via `signInWithCredential`:
 *      · Apple  → `expo-apple-authentication` (native sheet, required by
 *                 App Store guideline 4.8 whenever another social login exists)
 *      · Google → `expo-auth-session` with PKCE
 *      · Facebook → `expo-auth-session`, only when an app id is configured
 *
 * Every provider is CONFIG-GATED. A missing client id produces one clear message
 * instead of an opaque OAuth error, and the login screen can hide buttons that
 * cannot work (see `socialProviderAvailability`).
 */

// Required for the web/AuthSession redirect to complete.
WebBrowser.maybeCompleteAuthSession();

const GOOGLE_IDS = {
  expo: process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID_EXPO || '',
  ios: process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID_IOS || '',
  android: process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID_ANDROID || '',
  web: process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID_WEB || '',
};
const FACEBOOK_APP_ID = process.env.EXPO_PUBLIC_FACEBOOK_APP_ID || '';

class SocialAuthUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SocialAuthUnavailable';
  }
}

/**
 * Which providers can actually complete a sign-in on THIS platform right now.
 *
 * The login screen uses this to hide buttons instead of offering a flow that is
 * guaranteed to fail — the previous behaviour was a button that showed
 * "coming soon".
 */
export function socialProviderAvailability(): {
  google: boolean;
  apple: boolean;
  facebook: boolean;
} {
  if (Platform.OS === 'web') {
    // Firebase's popup flow needs no extra client ids of our own.
    return { google: true, apple: true, facebook: true };
  }
  const googleId =
    Platform.OS === 'ios' ? GOOGLE_IDS.ios : Platform.OS === 'android' ? GOOGLE_IDS.android : '';
  return {
    google: !!(googleId || GOOGLE_IDS.expo),
    // Apple Sign In only exists on iOS 13+.
    apple: Platform.OS === 'ios',
    facebook: !!FACEBOOK_APP_ID,
  };
}

/**
 * Route a freshly signed-in user to their destination, or to profile completion.
 *
 * `redirect` is the link the visitor was trying to reach before being asked to sign in
 * — almost always a `/@handle` profile, since those are the shared urls that require a
 * session. It is honoured only for a RETURNING user with a complete profile; a new
 * account is sent through onboarding, because dropping someone onto a stranger's
 * profile before they have a username of their own is not a shortcut worth taking.
 */
async function routeAfterSignIn(
  router: any,
  addToast: any,
  credential: UserCredential,
  providerName: ProviderName,
  redirect?: string | null,
  methods?: ClientAuthMethods,
) {
  const user = credential.user;
  const signupStore = useSignupStore.getState();

  // Look up the user's profile in D1 (via the Worker), keyed by uid.
  const userData: any = await readApi(`/read/users/${user.uid}`).catch(() => null);
  // The server's flag only: a username on a half-created row is not a finished account.
  const returning = isProfileComplete(userData);
  if (returning) markOnboardingComplete(user.uid, userData);
  else markOnboardingIncomplete(user.uid);

  // A NEW account through a method the admin switched off (or with signups
  // closed): say so now, not after the whole profile form. The Worker refuses it
  // regardless (lib/authMethods.ts); this is the early, friendly version.
  if (!returning && methods) {
    const blocked = signupBlockedReason(methods, signupKeyForProvider(PROVIDER_ID[providerName]));
    if (blocked) {
      await signOut(getAuth(app)).catch(() => {});
      addToast(blocked, 'info');
      return null;
    }
  }
  void rememberAuthMethod(providerName.toLowerCase() as 'google' | 'facebook' | 'apple');

  if (userData) {
    if (returning) {
      addToast('Welcome back!', 'success');
      router.replace(postAuthDestination(redirect));
    } else {
      signupStore.reset();
      signupStore.setMultiple({
        ...onboardingDraftFor(user, userData),
        authProvider: providerName.toLowerCase() as any,
      });
      addToast('Please complete your profile.', 'info');
      router.replace('/auth/signup/fill-profile');
    }
    return user;
  }

  // NEW USER: don't create the profile yet — collect the rest first.
  signupStore.reset();
  signupStore.setMultiple({
    fullName: user.displayName || '',
    email: user.email || '',
    avatarUrl: user.photoURL || '',
    authProvider: providerName.toLowerCase() as any,
  });
  addToast("Welcome! Let's complete your profile.", 'success');
  router.replace('/auth/signup/fill-profile');
  return user;
}

const PENDING_REDIRECT_KEY = 'tophunt:auth:pendingRedirect';

/** Thrown after `signInWithRedirect` starts: the page is navigating away. */
class RedirectStarted extends Error {
  constructor() {
    super('redirect-started');
    this.name = 'RedirectStarted';
  }
}

/**
 * Web sign-in: a popup, falling back to a full-page redirect when the browser
 * blocks the popup — but only where the redirect is reliable, i.e. when sign-in
 * runs on our own origin (lib/authDomain.ts). Cross-site, modern browsers drop
 * the redirect result, so there the user is told to allow the popup instead.
 */
async function webPopupSignIn(provider: any, providerName: ProviderName, redirect?: string | null): Promise<UserCredential> {
  const auth = getAuth(app);
  try {
    // The resolver is passed explicitly as well as at init, so a getAuth()
    // fallback instance (Fast Refresh) cannot throw auth/argument-error.
    return await signInWithPopup(auth, provider, browserPopupRedirectResolver);
  } catch (error: any) {
    const host = typeof window !== 'undefined' ? window.location.hostname : null;
    if (error?.code === 'auth/popup-blocked' && isSameSiteAuth(String(auth.config.authDomain || ''), host)) {
      try {
        window.sessionStorage.setItem(PENDING_REDIRECT_KEY, JSON.stringify({ providerName, redirect: redirect ?? null }));
      } catch {
        // Storage off: the redirect still signs the user in; only the post-login
        // destination is lost.
      }
      await signInWithRedirect(auth, provider, browserPopupRedirectResolver);
      throw new RedirectStarted();
    }
    throw error;
  }
}

/**
 * Finish a `signInWithRedirect` started above, after the page comes back. Call
 * once when the login/signup screen mounts on web; a no-op otherwise.
 */
export async function completeWebRedirectSignIn(router: any, addToast: any, methods?: ClientAuthMethods): Promise<void> {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return;
  let pending: { providerName: ProviderName; redirect: string | null } | null = null;
  try {
    const raw = window.sessionStorage.getItem(PENDING_REDIRECT_KEY);
    pending = raw ? JSON.parse(raw) : null;
  } catch {
    pending = null;
  }
  if (!pending) return;
  try {
    window.sessionStorage.removeItem(PENDING_REDIRECT_KEY);
  } catch {
    // ignore
  }
  try {
    const result = await getRedirectResult(getAuth(app), browserPopupRedirectResolver);
    if (result) await routeAfterSignIn(router, addToast, result, pending.providerName, pending.redirect, methods);
  } catch (error: any) {
    if (isAuthCancellation(error)) return;
    reportError(error, { flow: 'social-auth-redirect', provider: pending.providerName });
    addToast(friendlyAuthError(error, `${pending.providerName} login nahi ho paya. Dobara try karo.`), 'error');
  }
}

/**
 * Apple Sign In (native).
 *
 * A raw nonce is generated and its SHA-256 sent to Apple; Firebase then verifies
 * the raw value against the hash in the identity token. Skipping this makes the
 * credential replayable.
 */
async function appleNativeSignIn(): Promise<UserCredential> {
  const available = await AppleAuthentication.isAvailableAsync();
  if (!available) {
    throw new SocialAuthUnavailable('Apple Sign In is not available on this device.');
  }

  const rawNonce = Crypto.randomUUID();
  const hashedNonce = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    rawNonce,
  );

  const result = await AppleAuthentication.signInAsync({
    requestedScopes: [
      AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
      AppleAuthentication.AppleAuthenticationScope.EMAIL,
    ],
    nonce: hashedNonce,
  });

  if (!result.identityToken) {
    throw new Error('Apple did not return an identity token.');
  }

  const provider = new OAuthProvider('apple.com');
  const credential = provider.credential({
    idToken: result.identityToken,
    rawNonce,
  });
  const signedIn = await signInWithCredential(getAuth(app), credential);

  // Apple only sends the name on the FIRST authorisation, so capture it now or
  // it is gone for good.
  if (result.fullName?.givenName && !signedIn.user.displayName) {
    const name = [result.fullName.givenName, result.fullName.familyName].filter(Boolean).join(' ');
    if (name) useSignupStore.getState().setMultiple({ fullName: name });
  }
  return signedIn;
}

/** Google via expo-auth-session (native). Uses the id_token implicit flow. */
async function googleNativeSignIn(): Promise<UserCredential> {
  const clientId =
    Platform.OS === 'ios' ? GOOGLE_IDS.ios : Platform.OS === 'android' ? GOOGLE_IDS.android : '';
  const resolvedClientId = clientId || GOOGLE_IDS.expo;
  if (!resolvedClientId) {
    throw new SocialAuthUnavailable(
      'Google sign-in is not configured for this build. Please use email or phone.',
    );
  }

  const redirectUri = AuthSession.makeRedirectUri({ scheme: 'tophunt' });
  const discovery = await AuthSession.fetchDiscoveryAsync('https://accounts.google.com');
  const request = new AuthSession.AuthRequest({
    clientId: resolvedClientId,
    redirectUri,
    scopes: ['openid', 'profile', 'email'],
    responseType: AuthSession.ResponseType.IdToken,
    extraParams: { nonce: Crypto.randomUUID() },
  });

  const result = await request.promptAsync(discovery);
  if (result.type === 'cancel' || result.type === 'dismiss') {
    throw new SocialAuthUnavailable('cancelled');
  }
  if (result.type !== 'success') {
    throw new Error('Google sign-in did not complete.');
  }
  const idToken = (result.params as any)?.id_token;
  if (!idToken) throw new Error('Google did not return an identity token.');

  return signInWithCredential(getAuth(app), GoogleAuthProvider.credential(idToken));
}

/** Facebook via expo-auth-session (native). Requires an app id. */
async function facebookNativeSignIn(): Promise<UserCredential> {
  if (!FACEBOOK_APP_ID) {
    throw new SocialAuthUnavailable(
      'Facebook sign-in is not configured for this build. Please use email or phone.',
    );
  }
  const redirectUri = AuthSession.makeRedirectUri({ scheme: 'tophunt' });
  const request = new AuthSession.AuthRequest({
    clientId: FACEBOOK_APP_ID,
    redirectUri,
    scopes: ['public_profile', 'email'],
    responseType: AuthSession.ResponseType.Token,
    extraParams: { display: 'popup' },
  });
  const result = await request.promptAsync({
    authorizationEndpoint: 'https://www.facebook.com/v18.0/dialog/oauth',
  });
  if (result.type === 'cancel' || result.type === 'dismiss') {
    throw new SocialAuthUnavailable('cancelled');
  }
  if (result.type !== 'success') throw new Error('Facebook sign-in did not complete.');
  const accessToken = (result.params as any)?.access_token;
  if (!accessToken) throw new Error('Facebook did not return an access token.');

  return signInWithCredential(getAuth(app), FacebookAuthProvider.credential(accessToken));
}

async function run(
  router: any,
  addToast: any,
  providerName: ProviderName,
  native: () => Promise<UserCredential>,
  webProvider: () => any,
  redirect?: string | null,
  options?: SocialLoginOptions,
) {
  try {
    if (Platform.OS === 'web' && providerName === 'Google' && typeof navigator !== 'undefined') {
      // Google refuses OAuth inside Instagram/Facebook/… webviews
      // ("disallowed_useragent"): stop here with the fix instead of Google's error page.
      const iab = detectInAppBrowser(navigator.userAgent);
      if (iab.inApp) {
        throw new SocialAuthUnavailable(
          `${iab.name || 'Is app'} ke andar Google login kaam nahi karta. Upar ke menu se "Open in browser" / Chrome mein kholo, ya Phone se login karo.`,
        );
      }
    }
    const credential =
      Platform.OS === 'web' ? await webPopupSignIn(webProvider(), providerName, redirect) : await native();
    return await routeAfterSignIn(router, addToast, credential, providerName, redirect, options?.methods);
  } catch (error: any) {
    // The page is navigating to the provider; nothing to report or show.
    if (error instanceof RedirectStarted) throw error;
    // A user closing the sheet is not an error worth reporting or shouting about.
    if (isAuthCancellation(error)) throw error;

    if (error instanceof SocialAuthUnavailable) {
      addToast(error.message, 'info');
      throw error;
    }

    // Configuration states, not bugs: shown, not reported.
    const expected = ['auth/operation-not-allowed', 'auth/account-exists-with-different-credential', 'auth/popup-blocked', 'auth/network-request-failed', 'auth/too-many-requests', 'auth/user-disabled'];
    if (!expected.includes(String(error?.code || ''))) {
      reportError(error, { flow: 'social-auth', provider: providerName });
    }
    addToast(friendlyAuthError(error, `${providerName} login nahi ho paya. Dobara try karo ya email/phone use karo.`), 'error');
    throw error;
  }
}

export const SocialAuthService = {
  googleLogin: (router: any, addToast: any, redirect?: string | null, options?: SocialLoginOptions) =>
    run(router, addToast, 'Google', googleNativeSignIn, () => {
      const p = new GoogleAuthProvider();
      // Always show the account chooser, so a shared device does not silently
      // sign in as whoever used it last.
      p.setCustomParameters({ prompt: 'select_account' });
      return p;
    }, redirect, options),

  appleLogin: (router: any, addToast: any, redirect?: string | null, options?: SocialLoginOptions) =>
    run(router, addToast, 'Apple', appleNativeSignIn, () => {
      const p = new OAuthProvider('apple.com');
      p.addScope('email');
      p.addScope('name');
      return p;
    }, redirect, options),

  facebookLogin: (router: any, addToast: any, redirect?: string | null, options?: SocialLoginOptions) =>
    run(router, addToast, 'Facebook', facebookNativeSignIn, () => {
      const p = new FacebookAuthProvider();
      p.addScope('email');
      return p;
    }, redirect, options),
};
