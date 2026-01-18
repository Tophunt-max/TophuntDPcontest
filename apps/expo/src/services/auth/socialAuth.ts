import {
  FacebookAuthProvider,
  GoogleAuthProvider,
  OAuthProvider,
  signInWithPopup,
  getAuth,
} from "firebase/auth";
import app, { firestore as db } from "../firebase/initFirebase";
import { doc, getDoc, collection, query, where, getDocs, limit, setDoc, serverTimestamp } from "firebase/firestore";
import { useSignupStore } from "../../store/signup";

export const SocialAuthService = {
  handleSocialLogin: async (router: any, addToast: any, providerName: string, provider: any) => {
    try {
      const auth = getAuth(app);
      console.log(`[SocialAuth] Starting ${providerName} login...`);
      
      const userCredential = await signInWithPopup(auth, provider);
      const user = userCredential.user;

      const signupStore = useSignupStore.getState();

      let existingData: any = null;
      let existingDocId: string | null = null;

      // 1. SEARCH LOGIC: Always check by EMAIL first for consistency
      if (user.email) {
          const q = query(collection(db, "users"), where("email", "==", user.email.toLowerCase()), limit(1));
          const querySnapshot = await getDocs(q);
          if (!querySnapshot.empty) {
              existingData = querySnapshot.docs[0].data();
              existingDocId = querySnapshot.docs[0].id;
              console.log("[SocialAuth] Found existing user by email:", existingDocId);
          }
      }

      // 2. FALLBACK: Check by UID if email search failed
      if (!existingData) {
          const userDocSnap = await getDoc(doc(db, "users", user.uid));
          if (userDocSnap.exists()) {
              existingData = userDocSnap.data();
              existingDocId = user.uid;
              console.log("[SocialAuth] Found existing user by session UID.");
          }
      }

      // 3. DECISION & MIGRATION LOGIC
      if (existingData && (existingData.signupCompleted === true || existingData.username)) {
        
        // --- DATA MIGRATION CHECK ---
        if (existingDocId !== user.uid) {
            console.log("[SocialAuth] Migration needed! Cloning data to new UID:", user.uid);
            
            // Sync data to new UID document immediately
            const newDocRef = doc(db, "users", user.uid);
            await setDoc(newDocRef, {
                ...existingData,
                uid: user.uid,
                email: user.email?.toLowerCase(),
                updatedAt: serverTimestamp(),
                signupCompleted: true,
                migratedFrom: existingDocId
            }, { merge: true });

            console.log("[SocialAuth] Migration complete.");
        }

        addToast("Welcome back!", "success");
        router.replace("/home");

      } else {
        // TRULY NEW USER OR INCOMPLETE PROFILE
        console.log("[SocialAuth] New user or incomplete profile. Moving to Fill Profile.");
        
        signupStore.reset();
        signupStore.setMultiple({
            uid: user.uid,
            fullName: existingData?.fullName || user.displayName || "",
            email: (existingData?.email || user.email || "").toLowerCase(),
            avatarUrl: existingData?.profileImageUrl || existingData?.avatarUrl || user.photoURL || "",
            authProvider: providerName.toLowerCase() as any,
            ...(existingData || {}) 
        });

        addToast(`Please complete your profile.`, "info");
        router.replace("/auth/signup/fill-profile");
      }
      return user;
    } catch (error: any) {
      console.error(`${providerName} Error:`, error);
      let msg = error.message;
      if (error.code === 'auth/popup-closed-by-user') msg = "Login cancelled.";
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
