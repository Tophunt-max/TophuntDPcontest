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

export const signOut = async () => {
  console.log("[AuthService] signOut called");

  // Detach this device's push token FIRST, while the ID token is still valid —
  // the Worker call needs auth. Skipping this left the token on the user row
  // forever, so a shared or resold phone kept receiving the previous account's
  // notifications. Best-effort: never block logout on it.
  await notificationService.unregisterPushToken();

  try {
    await firebaseSignOut(auth);
    console.log("[AuthService] firebaseSignOut successful");
  } catch (error: any) {
    console.error("[AuthService] firebaseSignOut error:", error);
    throw new Error(error.message);
  }
};
