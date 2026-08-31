import { createUserWithEmailAndPassword, signOut as firebaseSignOut } from 'firebase/auth';
import { auth } from './firebase/initFirebase';
import { notificationService } from './notifications/notificationService';

// Single source of truth for auth state. Previously this module had its own
// duplicate `useAuth` implementation (a second onAuthStateChanged listener),
// which could drift from `hooks/useAuth`. Re-export the hook so every caller
// shares one implementation regardless of import path.
export { useAuth } from '../hooks/useAuth';

export const signupWithEmail = async (email: string, password: string) => {
  try {
    const userCredential = await createUserWithEmailAndPassword(auth, email, password);
    return userCredential.user;
  } catch (error: any) {
    throw new Error(error.message);
  }
};

export interface SignOutOptions {
  /**
   * Skip the authenticated call that detaches this device's push token.
   *
   * Set this when the account is already gone or out of service — after a
   * deletion request, or after the server has deleted the Firebase login. The
   * detach call cannot succeed in that state, and its failure is not harmless:
   * if the cached ID token is close to expiry the request goes out unauthorised,
   * the API layer reads the 401 as an expired session, and the user is shown
   * "Your session expired. Please sign in again." — an error toast, fired
   * immediately before the success toast for the thing they just did on purpose.
   *
   * There is nothing lost by skipping it. The server clears `fcmTokens` as part
   * of both the deletion request and the purge, which is the same end state this
   * call exists to reach.
   */
  skipPushTokenUnregister?: boolean;
}

export const signOut = async (options: SignOutOptions = {}) => {
  console.log("[AuthService] signOut called");

  if (!options.skipPushTokenUnregister) {
    // Detach this device's push token FIRST, while the ID token is still valid —
    // the Worker call needs auth. Skipping this left the token on the user row
    // forever, so a shared or resold phone kept receiving the previous account's
    // notifications. Best-effort: never block logout on it.
    await notificationService.unregisterPushToken();
  } else {
    // Still drop the local copy, so the next account on this device registers a
    // fresh token instead of reusing one the server has already forgotten.
    await notificationService.forgetLocalPushToken();
  }

  try {
    await firebaseSignOut(auth);
    console.log("[AuthService] firebaseSignOut successful");
  } catch (error: any) {
    console.error("[AuthService] firebaseSignOut error:", error);
    throw new Error(error.message);
  }
};
