import { doc, setDoc, updateDoc, serverTimestamp } from "firebase/firestore";
import { auth, firestore as db } from "../firebase/initFirebase";

export const saveUserProfile = async (data: any) => {
  const user = auth.currentUser;

  if (!user) throw new Error("No authenticated user found");

  const userRef = doc(db, "users", user.uid);

  // Merge with existing data
  await setDoc(userRef, {
    ...data,
    updatedAt: serverTimestamp(),
  }, { merge: true });
};

export const completeSignup = async () => {
    const user = auth.currentUser;
  
    if (!user) throw new Error("No authenticated user found");
  
    const userRef = doc(db, "users", user.uid);
    
    await updateDoc(userRef, {
        signupCompleted: true,
        updatedAt: serverTimestamp(),
    });
}
