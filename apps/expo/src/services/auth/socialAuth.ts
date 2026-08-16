import {
  FacebookAuthProvider,
  GoogleAuthProvider,
  OAuthProvider,
  signInWithPopup,
  browserPopupRedirectResolver,
  getAuth,
} from "firebase/auth";
import { Platform } from "react-native";
import app from "../firebase/initFirebase";
import { readApi } from "../api";
import { useSignupStore } from "../../store/signup";

export const SocialAuthService = {
  handleSocialLogin: async (router: any, addToast: any, providerName: string, provider: any) => {
    try {
      // `signInWithPopup` is a WEB-ONLY Firebase API. On a native (iOS/Android)
      // Expo build it throws `auth/operation-not-supported-in-this-environment`,
      // so social login silently breaks on the real app. Fail fast here with a
      // clear message instead of a cryptic Firebase crash.
      // TODO(native social auth): implement with `expo-auth-session` (Google)
      //   + `expo-apple-authentication` (Apple) and exchange the OAuth
      //   credential via Firebase `signInWithCredential`.
      if (Platform.OS !== "web") {
        addToast(`${providerName} sign-in isn't available in the app yet. Please use email or phone.`, "info");
        throw new Error("social-auth-unsupported-native");
      }

      const auth = getAuth(app);
      console.log(`Starting ${providerName} login...`);

      // Pass the popup/redirect resolver explicitly. Auth is initialised via
      // initializeAuth() WITHOUT a popupRedirectResolver, so calling
      // signInWithPopup(auth, provider) alone throws `auth/argument-error` on
      // web. Supplying the resolver here fixes social login.
      const userCredential = await signInWithPopup(auth, provider, browserPopupRedirectResolver);
      const user = userCredential.user;

      const signupStore = useSignupStore.getState();

      // Look up the user's profile in D1 (via the Worker), keyed by uid.
      const userData: any = await readApi(`/read/users/${user.uid}`).catch(() => null);

      if (userData) {
        // EXISTING USER
        if (userData.signupCompleted === true || userData.username) {
          addToast("Welcome back!", "success");
          router.replace("/home");
        } else {
          // Incomplete Profile
          signupStore.setMultiple({
            ...userData,
            fullName: userData.fullName || user.displayName || "",
            email: userData.email || user.email || "",
            avatarUrl: userData.avatarUrl || user.photoURL || "",
            authProvider: (userData.authProvider || providerName.toLowerCase()) as any
          });
          addToast("Please complete your profile.", "info");
          router.replace("/auth/signup/fill-profile");
        }
      } else {
        // NEW USER: Don't create doc yet, just save to store and redirect
        console.log("New Social User detected:", user.email || user.uid);
        
        signupStore.reset();
        signupStore.setMultiple({
            fullName: user.displayName || "",
            email: user.email || "",
            avatarUrl: user.photoURL || "",
            authProvider: providerName.toLowerCase() as any
        });

        addToast(`Welcome! Let's complete your profile.`, "success");
        router.replace("/auth/signup/fill-profile");
      }
      return user;
    } catch (error: any) {
      console.error(`${providerName} Error:`, error);
      // Already surfaced a friendly info toast for the native-unsupported case.
      if (error?.message === "social-auth-unsupported-native") throw error;
      let msg = error.message;
      if (error.code === 'auth/popup-closed-by-user') msg = "Popup closed.";
      addToast(msg, "error");
      throw error;
    }
  },

  googleLogin: async (router: any, addToast: any) => {
    const provider = new GoogleAuthProvider();
    return await SocialAuthService.handleSocialLogin(router, addToast, "Google", provider);
  },

  facebookLogin: async (router: any, addToast: any) => {
    const provider = new FacebookAuthProvider();
    return await SocialAuthService.handleSocialLogin(router, addToast, "Facebook", provider);
  },

  appleLogin: async (router: any, addToast: any) => {
    const provider = new OAuthProvider("apple.com");
    return await SocialAuthService.handleSocialLogin(router, addToast, "Apple", provider);
  },
};
