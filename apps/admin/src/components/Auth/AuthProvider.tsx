"use client";

import { useEffect, useState, createContext, useContext } from "react";
import { auth } from "@/lib/firebase/config";
import { onAuthStateChanged, User } from "firebase/auth";
import { useRouter, usePathname } from "next/navigation";

interface AuthContextType {
  user: User | null;
  loading: boolean;
}

const AuthContext = createContext<AuthContextType>({ user: null, loading: true });

export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user) {
        const idTokenResult = await user.getIdTokenResult();
        if (idTokenResult.claims.role === "admin") {
          setUser(user);
          if (pathname === "/auth/sign-in") {
            router.push("/");
          }
        } else {
          await auth.signOut();
          setUser(null);
          if (pathname !== "/auth/sign-in") {
            router.push("/auth/sign-in");
          }
        }
      } else {
        setUser(null);
        if (pathname !== "/auth/sign-in") {
          router.push("/auth/sign-in");
        }
      }
      setLoading(false);
    });

    return () => unsubscribe();
  }, [pathname, router]);

  if (loading) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-white dark:bg-black">
        <div className="h-16 w-16 animate-spin rounded-full border-4 border-solid border-primary border-t-transparent"></div>
      </div>
    );
  }

  if (pathname === "/auth/sign-in") {
    return <>{children}</>;
  }

  if (!user && pathname !== "/auth/sign-in") {
      return null;
  }

  return (
    <AuthContext.Provider value={{ user, loading }}>
      {children}
    </AuthContext.Provider>
  );
}
