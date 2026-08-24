import {
  FacebookAuthProvider,
  GoogleAuthProvider,
  OAuthProvider,
  signInWithPopup,
  signInWithCredential,
  browserPopupRedirectResolver,
  getAuth,
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
import { reportError } from '@/src/lib/reportError';

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

/** Route a freshly signed-in user to home or to profile completion. */
async function routeAfterSignIn(
  router: any,
  addToast: any,
  credential: UserCredential,
  providerName: string,
) {
  const user = credential.user;
  const signupStore = useSignupStore.getState();

  // Look up the user's profile in D1 (via the Worker), keyed by uid.
  const userData: any = await readApi(`/read/users/${user.uid}`).catch(() => null);

  if (userData) {
    if (userData.signupCompleted === true || userData.username) {
      addToast('Welcome back!', 'success');
      router.replace('/home');
    } else {
      signupStore.setMultiple({
        ...userData,
        fullName: userData.fullName || user.displayName || '',
        email: userData.email || user.email || '',
        avatarUrl: userData.avatarUrl || user.photoURL || '',
        authProvider: (userData.authProvider || providerName.toLowerCase()) as any,
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

/** Web-only popup flow (unchanged behaviour on web). */
async function webPopupSignIn(provider: any): Promise<UserCredential> {
  const auth = getAuth(app);
  // Auth is initialised via initializeAuth() WITHOUT a popupRedirectResolver, so
  // the resolver must be passed explicitly or Firebase throws auth/argument-error.
  return signInWithPopup(auth, provider, browserPopupRedirectResolver);
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
  providerName: 'Google' | 'Apple' | 'Facebook',
  native: () => Promise<UserCredential>,
  webProvider: () => any,
) {
  try {
    const credential =
      Platform.OS === 'web' ? await webPopupSignIn(webProvider()) : await native();
    return await routeAfterSignIn(router, addToast, credential, providerName);
  } catch (error: any) {
    // A user closing the sheet is not an error worth reporting or shouting about.
    const cancelled =
      error?.message === 'cancelled' ||
      error?.code === 'auth/popup-closed-by-user' ||
      error?.code === 'ERR_REQUEST_CANCELED' ||
      error?.code === 'ERR_CANCELED';
    if (cancelled) throw error;

    if (error instanceof SocialAuthUnavailable) {
      addToast(error.message, 'info');
      throw error;
    }

    reportError(error, { flow: 'social-auth', provider: providerName });
    addToast(
      error?.message || `${providerName} sign-in failed. Please try again or use email.`,
      'error',
    );
    throw error;
  }
}

export const SocialAuthService = {
  googleLogin: (router: any, addToast: any) =>
    run(router, addToast, 'Google', googleNativeSignIn, () => new GoogleAuthProvider()),

  appleLogin: (router: any, addToast: any) =>
    run(router, addToast, 'Apple', appleNativeSignIn, () => new OAuthProvider('apple.com')),

  facebookLogin: (router: any, addToast: any) =>
    run(router, addToast, 'Facebook', facebookNativeSignIn, () => new FacebookAuthProvider()),
};
