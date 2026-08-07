import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { firebaseReady } from "@/lib/firebase";
import { Lock, Mail, Loader2, ShieldAlert } from "lucide-react";

export default function Login() {
  const { login, error } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [localErr, setLocalErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setLocalErr(null);
    try {
      await login(email.trim(), password);
    } catch (err: any) {
      const code = err?.code || "";
      setLocalErr(
        code.includes("invalid") || code.includes("wrong") || code.includes("not-found")
          ? "Invalid email or password."
          : err?.message || "Login failed.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-24 -right-24 w-96 h-96 rounded-full gradient-purple opacity-10 blur-3xl" />
        <div className="absolute -bottom-24 -left-24 w-96 h-96 rounded-full gradient-blue opacity-10 blur-3xl" />
      </div>

      <div className="relative w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <div className="w-14 h-14 rounded-2xl gradient-purple flex items-center justify-center shadow-xl mb-4">
            <span className="text-white font-bold text-2xl">T</span>
          </div>
          <h1 className="text-xl font-bold text-foreground">TopHunt Admin</h1>
          <p className="text-sm text-muted-foreground">Sign in to the admin console</p>
        </div>

        <form
          onSubmit={submit}
          className="bg-card border border-border rounded-2xl p-6 shadow-sm space-y-4"
        >
          {!firebaseReady && (
            <div className="flex items-start gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3">
              <ShieldAlert size={16} className="flex-shrink-0 mt-0.5" />
              <span>
                Firebase is not configured. Set the <code>VITE_FIREBASE_*</code>{" "}
                build variables to enable login.
              </span>
            </div>
          )}

          <div>
            <label className="text-sm font-medium text-foreground mb-1.5 block">Email</label>
            <div className="relative">
              <Mail size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="admin@tophunt.app"
                className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>

          <div>
            <label className="text-sm font-medium text-foreground mb-1.5 block">Password</label>
            <div className="relative">
              <Lock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>

          {(localErr || error) && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {localErr || error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy || !firebaseReady}
            className="w-full gradient-purple text-white font-semibold py-2.5 rounded-xl shadow-lg hover:opacity-95 transition-opacity disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {busy && <Loader2 size={16} className="animate-spin" />}
            Sign In
          </button>
        </form>

        <p className="text-center text-xs text-muted-foreground mt-6">
          TopHunt Admin Console · Secured by Firebase
        </p>
      </div>
    </div>
  );
}
