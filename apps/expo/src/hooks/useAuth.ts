import { useState, useEffect } from 'react';
import { onAuthStateChanged, User } from 'firebase/auth';
import { doc, onSnapshot } from 'firebase/firestore';
import { auth, firestore as db } from '../services/firebase/initFirebase';

export interface ExtendedUser extends User {
  signupCompleted?: boolean;
  username?: string;
  isNewUser?: boolean;
}

export const useAuth = () => {
  const [user, setUser] = useState<ExtendedUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [isNewUser, setIsNewUser] = useState(false);

  useEffect(() => {
    const unsubscribeAuth = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        console.log("[useAuth] Firebase User detected:", firebaseUser.uid);
        
        // Listen to the user's Firestore document for real-time profile status
        const userDocRef = doc(db, "users", firebaseUser.uid);
        
        const unsubscribeDoc = onSnapshot(userDocRef, (docSnap) => {
          if (docSnap.exists()) {
            const userData = docSnap.data();
            console.log("[useAuth] Firestore User data found. signupCompleted:", userData.signupCompleted);
            
            setUser({
              ...firebaseUser,
              signupCompleted: !!userData.signupCompleted,
              username: userData.username || "",
            } as ExtendedUser);
            setIsNewUser(false);
          } else {
            console.log("[useAuth] No Firestore document found for UID:", firebaseUser.uid);
            // User authenticated in Firebase but no profile in Firestore yet
            setUser({
              ...firebaseUser,
              signupCompleted: false,
            } as ExtendedUser);
            setIsNewUser(true);
          }
          setLoading(false);
        }, (error) => {
          console.error("[useAuth] Firestore Snapshot Error:", error);
          // If we can't read Firestore, we still have the Auth user
          setUser(firebaseUser as ExtendedUser);
          setLoading(false);
        });

        return () => unsubscribeDoc();
      } else {
        console.log("[useAuth] No Firebase User found.");
        setUser(null);
        setIsNewUser(false);
        setLoading(false);
      }
    });

    return () => unsubscribeAuth();
  }, []);

  return { user, loading, isNewUser };
};
