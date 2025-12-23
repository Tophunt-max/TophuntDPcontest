
import {
  signInWithPopup,
  FacebookAuthProvider,
  GoogleAuthProvider,
  OAuthProvider,
} from "firebase/auth";
import { auth }_ from "../firebase/initFirebase";

export const signInWithGoogle = async () => {
  const provider = new GoogleAuthProvider();
  try {
    const result = await signInWithPopup(auth(), provider);
    return result.user;
  } catch (error) {
    console.error("Error signing in with Google:", error);
    return null;
  }
};

export const SocialAuthService = {
  facebookLogin: async () => {
    try {
      // Note: In React Native with Expo, direct popup often doesn't work.
      // Usually you use expo-auth-session + Firebase credentials.
      // For this output, I'll stub the standard web-like logic or a placeholder.
      // Real implementation requires native setup or expo-auth-session
      console.log("Initiating Facebook Login...");
      const provider = new FacebookAuthProvider();
      // await signInWithRedirect(auth, provider); // Web flow
      // For native, use expo-facebook or similar wrapper
    } catch (error) {
      console.error("Facebook Login Error:", error);
      throw error;
    }
  },

  googleLogin: async () => {
    try {
      console.log("Initiating Google Login...");
      const provider = new GoogleAuthProvider();
      // await signInWithRedirect(auth, provider);
    } catch (error) {
      console.error("Google Login Error:", error);
      throw error;
    }
  },

  appleLogin: async () => {
    try {
      console.log("Initiating Apple Login...");
      const provider = new OAuthProvider("apple.com");
      // await signInWithPopup(auth, provider);
    } catch (error) {
      console.error("Apple Login Error:", error);
      throw error;
    }
  },
};
