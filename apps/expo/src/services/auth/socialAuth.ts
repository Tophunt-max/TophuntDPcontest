import {
  FacebookAuthProvider,
  GoogleAuthProvider,
  OAuthProvider,
  signInWithPopup,
  getAuth,
} from "firebase/auth";
import app, { firestore as db } from "../firebase/initFirebase";
import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { useSignupStore } from "../../store/signup";

export const SocialAuthService = {
  handleSocialLogin: async (router: any, addToast: any, providerName: string, provider: any) => {
    try {
      const auth = getAuth(app);
      console.log(`Starting ${providerName} login...`);
      
      const userCredential = await signInWithPopup(auth, provider);
      const user = userCredential.user;

      const userDocRef = doc(db, "users", user.uid);
      const userDoc = await getDoc(userDocRef);
      
      const signupStore = useSignupStore.getState();

      if (!userDoc.exists()) {
        // NEW USER: Auto-fill from social profile
        const newUserData = {
          fullName: user.displayName || "",
          email: user.email || "",
          avatarUrl: user.photoURL || "",
          uid: user.uid,
          createdAt: serverTimestamp(),
          signupCompleted: false,
          authProvider: providerName.toLowerCase(),
        };
        await setDoc(userDocRef, newUserData);

        // Update Signup Store for Fill Profile page
        signupStore.setMultiple({
            fullName: user.displayName || "",
            email: user.email || "",
            avatarUrl: user.photoURL || "",
            authProvider: providerName.toLowerCase() as any
        });

        addToast(`Welcome ${user.displayName || 'User'}!`, "success");
        router.replace("/auth/signup/fill-profile");
      } else {
        // RETURNING USER
        const userData = userDoc.data();
        if (userData.signupCompleted) {
          addToast("Welcome back!", "success");
          router.replace("/home");
        } else {
          // Sync store with existing data if profile not completed
          signupStore.setMultiple({
            fullName: userData.fullName || user.displayName || "",
            email: userData.email || user.email || "",
            avatarUrl: userData.avatarUrl || user.photoURL || "",
            authProvider: (userData.authProvider || providerName.toLowerCase()) as any
          });
          router.replace("/auth/signup/fill-profile");
        }
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
