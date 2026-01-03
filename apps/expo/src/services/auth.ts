import { useState, useEffect } from 'react';
import { onAuthStateChanged, User, createUserWithEmailAndPassword, signOut as firebaseSignOut } from 'firebase/auth';
import { auth } from './firebase/initFirebase';

export const useAuth = () => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setUser(user);
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  return { user, loading };
};

export const signupWithEmail = async (email: string, password: string) => {
  try {
    const userCredential = await createUserWithEmailAndPassword(auth, email, password);
    return userCredential.user;
  } catch (error: any) {
    throw new Error(error.message);
  }
};

export const signOut = async () => {
  console.log("[AuthService] signOut called");
  try {
    await firebaseSignOut(auth);
    console.log("[AuthService] firebaseSignOut successful");
  } catch (error: any) {
    console.error("[AuthService] firebaseSignOut error:", error);
    throw new Error(error.message);
  }
};
