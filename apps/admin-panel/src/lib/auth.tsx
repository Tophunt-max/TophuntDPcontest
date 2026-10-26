import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  ReactNode,
} from "react";
import {
  EmailAuthProvider,
  reauthenticateWithCredential,
  signInWithEmailAndPassword,
  signOut,
  onIdTokenChanged,
  type User as FirebaseUser,
} from "firebase/auth";
import { auth } from "./firebase";
import { api, setReauthHandler } from "./api";
import { ReauthDialog } from "@/components/ReauthDialog";

/** Server-side role. Moderators see the moderation pages only. */
export type AdminRole = "superadmin" | "admin" | "moderator";
export const isFullAdminRole = (r: AdminRole | null | undefined) => r === "superadmin" || r === "admin";

export interface AdminUser {
  uid: string;
  name: string;
  email: string | null;
  photoURL: string | null;
  /** From /admin/overview; null when the server is older and does not say. */
  role: AdminRole | null;
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

function toAdminUser(u: FirebaseUser, role: AdminRole | null = null): AdminUser {
  return {
    uid: u.uid,
    name: u.displayName || (u.email ? u.email.split("@")[0] : "Admin"),
    email: u.email,
    photoURL: u.photoURL,
    role,
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
        const ov: any = await api.overview(); // 403 if not an admin
        const role = ["superadmin", "admin", "moderator"].includes(ov?.viewerRole) ? (ov.viewerRole as AdminRole) : null;
        setUser(toAdminUser(fbUser, role));
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

  // "Sudo mode": the API asks for the password again before sensitive actions.
  const [reauth, setReauth] = useState<{ resolve: (ok: boolean) => void } | null>(null);
  const reauthRef = useRef(reauth);
  reauthRef.current = reauth;
  useEffect(() => {
    setReauthHandler(
      () =>
        new Promise<boolean>((resolve) => {
          if (reauthRef.current) reauthRef.current.resolve(false);
          setReauth({ resolve });
        }),
    );
    return () => setReauthHandler(null);
  }, []);
  const confirmPassword = async (password: string) => {
    const u = auth.currentUser;
    if (!u?.email) throw new Error("no-email");
    await reauthenticateWithCredential(u, EmailAuthProvider.credential(u.email, password));
    await u.getIdToken(true);
    reauth?.resolve(true);
    setReauth(null);
  };
  const cancelReauth = () => {
    reauth?.resolve(false);
    setReauth(null);
  };

  const logout = () => {
    signOut(auth).catch(() => {});
    setUser(null);
  };

  return (
    <Ctx.Provider value={{ user, login, logout, loading, error }}>
      {children}
      {reauth && <ReauthDialog email={auth.currentUser?.email ?? null} onSubmit={confirmPassword} onCancel={cancelReauth} />}
    </Ctx.Provider>
  );
}
