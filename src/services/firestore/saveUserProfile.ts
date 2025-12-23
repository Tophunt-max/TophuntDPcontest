import { doc, setDoc, updateDoc, serverTimestamp, getFirestore } from "firebase/firestore";
import { getAuth } from "firebase/auth";
import { useSignupStore } from "../../store/signup";

export const saveUserProfile = async (data: any) => {
  const auth = getAuth();
  const db = getFirestore();
  const user = auth.currentUser;

  if (!user) throw new Error("No authenticated user found");

  const userRef = doc(db, "users", user.uid);

  // Merge with existing data
  await setDoc(userRef, {
    ...data,
    updatedAt: serverTimestamp(),
    // Only set createdAt if it doesn't exist (handled by merge usually, but logic here ensures safety)
  }, { merge: true });
  
  // Also update auth profile if needed
  // await updateProfile(user, { displayName: data.fullName, photoURL: data.avatarUrl });
};

export const completeSignup = async () => {
    const auth = getAuth();
    const db = getFirestore();
    const user = auth.currentUser;
  
    if (!user) throw new Error("No authenticated user found");
  
    const userRef = doc(db, "users", user.uid);
    
    await updateDoc(userRef, {
        signupCompleted: true,
        updatedAt: serverTimestamp(),
    });
}
