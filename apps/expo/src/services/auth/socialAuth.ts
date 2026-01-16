import {
  FacebookAuthProvider,
  GoogleAuthProvider,
  OAuthProvider,
  signInWithPopup,
  getAuth,
} from "firebase/auth";
import app, { firestore as db } from "../firebase/initFirebase";
import { doc, getDoc, collection, query, where, getDocs, limit } from "firebase/firestore";
import { useSignupStore } from "../../store/signup";

export const SocialAuthService = {
  handleSocialLogin: async (router: any, addToast: any, providerName: string, provider: any) => {
    try {
      const auth = getAuth(app);
      console.log(`Starting ${providerName} login...`);
      
      // NOTE: signInWithPopup only works on Web. 
      // For Native (iOS/Android), consider using expo-auth-session or native SDKs.
      const userCredential = await signInWithPopup(auth, provider);
      const user = userCredential.user;

      const signupStore = useSignupStore.getState();

      // 1. Check by UID first
      const userDocRef = doc(db, "users", user.uid);
      const userDocSnap = await getDoc(userDocRef);
      
      let userData: any = null;
      if (userDocSnap.exists()) {
          userData = userDocSnap.data();
          userData.uid = user.uid; // Ensure UID is attached
      } else if (user.email) {
          // 2. Check by Email field (in case they have a different UID but same email)
          const q = query(collection(db, "users"), where("email", "==", user.email), limit(1));
          const querySnapshot = await getDocs(q);
          if (!querySnapshot.empty) {
              userData = querySnapshot.docs[0].data();
              userData.uid = querySnapshot.docs[0].id; // The existing UID in Firestore
          }
      }

      if (userData) {
        // EXISTING USER FOUND
        if (userData.signupCompleted === true || userData.username) {
          console.log("Existing user found, redirecting to home");
          addToast("Welcome back!", "success");
          router.replace("/home");
        } else {
          // Incomplete Profile
          console.log("Incomplete profile found, updating store");
          signupStore.setMultiple({
            ...userData,
            uid: userData.uid || user.uid,
            fullName: userData.fullName || user.displayName || "",
            email: userData.email || user.email || "",
            avatarUrl: userData.avatarUrl || user.photoURL || "",
            authProvider: (userData.authProvider || providerName.toLowerCase()) as any
          });
          addToast("Please complete your profile.", "info");
          router.replace("/auth/signup/fill-profile");
        }
      } else {
        // NEW USER: Just save to store and redirect
        console.log("New Social User detected:", user.email || user.uid);
        
        signupStore.reset();
        signupStore.setMultiple({
            uid: user.uid,
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
