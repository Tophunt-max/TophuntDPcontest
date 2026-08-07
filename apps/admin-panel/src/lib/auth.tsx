import {
  createContext,
  useContext,
  useEffect,
  useState,
  ReactNode,
} from "react";
import {
  signInWithEmailAndPassword,
  signOut,
  onIdTokenChanged,
  type User as FirebaseUser,
} from "firebase/auth";
import { auth } from "./firebase";
import { api } from "./api";

export interface AdminUser {
  uid: string;
  name: string;
  email: string | null;
  photoURL: string | null;
}

interface AuthCtx {
  user: AdminUser | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  loading: boolean;
  error: string | null;
}

const Ctx = createContext<AuthCtx>(null!);
export const useAuth = () => useContext(Ctx);

function toAdminUser(u: FirebaseUser): AdminUser {
  return {
    uid: u.uid,
    name: u.displayName || (u.email ? u.email.split("@")[0] : "Admin"),
    email: u.email,
    photoURL: u.photoURL,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AdminUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Track Firebase session. We only treat the user as an authenticated admin
    // once the Worker confirms the admin role (a cheap /admin/overview probe).
    const unsub = onIdTokenChanged(auth, async (fbUser) => {
      if (!fbUser) {
        setUser(null);
        setLoading(false);
        return;
      }
      try {
        await api.overview(); // 403 if not an admin
        setUser(toAdminUser(fbUser));
        setError(null);
      } catch (e: any) {
        if (e?.status === 403) {
          setError("This account does not have admin access.");
          await signOut(auth).catch(() => {});
          setUser(null);
        } else {
          // Network/other error — keep the Firebase identity so the UI renders;
          // individual pages will surface their own errors.
          setUser(toAdminUser(fbUser));
        }
      } finally {
        setLoading(false);
      }
    });
    return () => unsub();
  }, []);

  const login = async (email: string, password: string) => {
    setError(null);
    await signInWithEmailAndPassword(auth, email, password);
    // Role verification happens in onIdTokenChanged above.
  };

  const logout = () => {
    signOut(auth).catch(() => {});
    setUser(null);
  };

  return (
    <Ctx.Provider value={{ user, login, logout, loading, error }}>
      {children}
    </Ctx.Provider>
  );
}
