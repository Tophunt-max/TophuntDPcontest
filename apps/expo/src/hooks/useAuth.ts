import { useState, useEffect } from 'react';
import { onAuthStateChanged, User } from 'firebase/auth';
import { doc, onSnapshot, Unsubscribe } from 'firebase/firestore';
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
    let unsubscribeDoc: Unsubscribe | null = null;

    const unsubscribeAuth = onAuthStateChanged(auth, async (firebaseUser) => {
      // Clean up previous doc listener if it exists
      if (unsubscribeDoc) {
        unsubscribeDoc();
        unsubscribeDoc = null;
      }

      if (firebaseUser) {
        console.log("[useAuth] Firebase User detected:", firebaseUser.uid);
        
        const userDocRef = doc(db, "users", firebaseUser.uid);
        
        unsubscribeDoc = onSnapshot(userDocRef, (docSnap) => {
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
            setUser({
              ...firebaseUser,
              signupCompleted: false,
            } as ExtendedUser);
            setIsNewUser(true);
          }
          setLoading(false);
        }, (error) => {
          console.error("[useAuth] Firestore Snapshot Error:", error);
          // If we can't read Firestore (maybe permissions error during logout transition),
          // we should check if the user is still actually logged in to Firebase
          if (auth.currentUser) {
            setUser(firebaseUser as ExtendedUser);
          } else {
            setUser(null);
          }
          setLoading(false);
        });
      } else {
        console.log("[useAuth] No Firebase User found.");
        setUser(null);
        setIsNewUser(false);
        setLoading(false);
      }
    });

    return () => {
      unsubscribeAuth();
      if (unsubscribeDoc) unsubscribeDoc();
    };
  }, []);

  return { user, loading, isNewUser };
};
