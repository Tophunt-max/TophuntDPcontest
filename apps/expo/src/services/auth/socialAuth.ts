import {
  FacebookAuthProvider,
  GoogleAuthProvider,
  OAuthProvider,
  signInWithPopup,
  getAuth,
} from "firebase/auth";
import app from "../firebase/initFirebase";
import { readApi } from "../api";
import { useSignupStore } from "../../store/signup";

export const SocialAuthService = {
  handleSocialLogin: async (router: any, addToast: any, providerName: string, provider: any) => {
    try {
      const auth = getAuth(app);
      console.log(`Starting ${providerName} login...`);
      
      const userCredential = await signInWithPopup(auth, provider);
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
