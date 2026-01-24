import {
  FacebookAuthProvider,
  GoogleAuthProvider,
  OAuthProvider,
  signInWithPopup,
  getAuth,
  linkWithCredential,
  fetchSignInMethodsForEmail,
  AuthCredential,
  signOut
} from "firebase/auth";
import app, { firestore as db } from "../firebase/initFirebase";
import { doc, getDoc } from "firebase/firestore";
import { useSignupStore } from "../../store/signup";

// Using a module-level variable to store pending credentials during the session
let pendingCredential: AuthCredential | null = null;

export const SocialAuthService = {
  getPendingCredential: () => pendingCredential,
  clearPendingCredential: () => { pendingCredential = null; },

  handleSocialLogin: async (router: any, addToast: any, providerName: string, provider: any) => {
    const auth = getAuth(app);
    try {
      console.log(`[SocialAuth] Starting ${providerName} login...`);
      const userCredential = await signInWithPopup(auth, provider);
      const user = userCredential.user;

      // Check if user document exists in Firestore
      const userDocSnap = await getDoc(doc(db, "users", user.uid));
      const existingData = userDocSnap.exists() ? userDocSnap.data() : null;

      // Logic: If user exists and has completed signup, go to home
      if (existingData && existingData.signupCompleted) {
        addToast("Welcome back!", "success");
        router.replace("/home");
      } else {
        // New user or Incomplete Profile
        const signupStore = useSignupStore.getState();
        signupStore.reset();
        signupStore.setMultiple({
            uid: user.uid,
            fullName: existingData?.fullName || user.displayName || "",
            email: (existingData?.email || user.email || "").toLowerCase(),
            avatarUrl: existingData?.profileImageUrl || user.photoURL || "",
            authProvider: providerName.toLowerCase() as any,
        });

        addToast(`Please complete your profile to continue.`, "info");
        // We don't delete the Firebase Auth user here, but we force them to fill profile
        // The app's root guard should handle redirection if they try to skip
        router.push("/auth/signup/fill-profile");
      }
      return user;
    } catch (error: any) {
      if (error.code === 'auth/account-exists-with-different-credential') {
        pendingCredential = error.credential;
        const email = error.customData.email;
        const methods = await fetchSignInMethodsForEmail(auth, email);
        
        addToast(`This email is already linked with ${methods[0]}. Please login to link ${providerName}.`, "warning");
        
        router.push({
            pathname: "/auth/login/password",
            params: { email: email }
        });
      } else {
        let msg = error.message;
        if (error.code === 'auth/popup-closed-by-user') msg = "Login cancelled.";
        addToast(msg, "error");
      }
      throw error;
    }
  },

  googleLogin: async (router: any, addToast: any) => {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
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

  // Helper to ensure half-logged in users are handled
  logoutIfIncomplete: async () => {
     const auth = getAuth(app);
     await signOut(auth);
  }
};
