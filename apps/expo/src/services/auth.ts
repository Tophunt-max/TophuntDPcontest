import { createUserWithEmailAndPassword, signOut as firebaseSignOut } from 'firebase/auth';
import { auth } from './firebase/initFirebase';

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
  try {
    await firebaseSignOut(auth);
    console.log("[AuthService] firebaseSignOut successful");
  } catch (error: any) {
    console.error("[AuthService] firebaseSignOut error:", error);
    throw new Error(error.message);
  }
};
