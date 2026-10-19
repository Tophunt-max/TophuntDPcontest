import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { KeyRound, Save, AlertTriangle } from "lucide-react";

type Platform = "web" | "android" | "ios";
type Switch = { enabled: boolean; web: boolean; android: boolean; ios: boolean };
type MethodKey = "google" | "facebook" | "apple" | "phone" | "password" | "emailSignup";
type Methods = { signupsEnabled: boolean; signupsClosedMessage: string } & Record<MethodKey, Switch>;

const PLATFORMS: Platform[] = ["web", "android", "ios"];
const LOGIN_KEYS: MethodKey[] = ["google", "facebook", "apple", "phone", "password"];
const ROWS: { key: MethodKey; label: string; hint?: string }[] = [
  { key: "google", label: "Google" },
  {
    key: "facebook",
    label: "Facebook",
    hint: "Facebook app ke 'Valid OAuth Redirect URIs' mein https://tophunt.in/__/auth/handler hona chahiye.",
  },
  {
    key: "apple",
    label: "Apple",
    hint: "Pehle Firebase console → Authentication → Sign-in method mein Apple enable karo, warna login fail hoga.",
  },
  { key: "phone", label: "Phone OTP" },
  { key: "password", label: "Email + password login" },
  { key: "emailSignup", label: "Email signup (naya account)" },
];
const PROVIDER_LABEL: Record<string, string> = {
  "google.com": "Google",
  "facebook.com": "Facebook",
  "apple.com": "Apple",
  password: "Email",
  custom: "Phone",
  unknown: "Unknown (older)",
};

/**
 * App Control → Login & Signup.
 *
 * A method switched OFF disappears from the app's login and signup screens on
 * that platform, and the server refuses NEW accounts through it (phone OTP is
 * refused entirely). People already signed in stay signed in. Saved on its own
 * (`{ authMethods }` only), so it never races the rest of App Control.
 */
export function AuthMethodsCard() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["auth-methods"], queryFn: api.authMethods });
  const [m, setM] = useState<Methods | null>(null);

  useEffect(() => {
    if (data?.methods) setM(data.methods);
  }, [data]);

  const saveMut = useMutation({
    mutationFn: (next: Methods) => api.saveAuthMethods(next),
    onSuccess: () => {
      toast.success("Login & signup settings saved — app mein ~2 minute mein lag jayega");
      qc.invalidateQueries({ queryKey: ["auth-methods"] });
      qc.invalidateQueries({ queryKey: ["app-settings"] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  if (isLoading || !m) {
    return <div className="text-sm text-muted-foreground py-6">Loading login settings…</div>;
  }

  const set = (key: MethodKey, patch: Partial<Switch>) => setM({ ...m, [key]: { ...m[key], ...patch } });
  const usable = (key: MethodKey, p: Platform) => m[key].enabled && m[key][p];
  const lockedOut = PLATFORMS.filter((p) => !LOGIN_KEYS.some((k) => usable(k, p)));

  const save = () => {
    if (lockedOut.length) {
      toast.error(`Kam se kam ek login tarika on rakho: ${lockedOut.join(", ")}`);
      return;
    }
    if (m.signupsClosedMessage.length > 200) {
      toast.error("Message 200 characters se chhota rakho.");
      return;
    }
    saveMut.mutate(m);
  };

  const stats: { provider: string; count: number }[] = data?.signups30d || [];

  return (
    <div className="bg-card border border-border rounded-2xl p-5 lg:col-span-2">
      <div className="flex items-center justify-between mb-4 gap-3">
        <h3 className="font-bold text-foreground flex items-center gap-2">
          <KeyRound size={16} className="text-pink-500" /> Login &amp; Signup
        </h3>
        <button
          onClick={save}
          disabled={saveMut.isPending}
          className="flex items-center gap-2 gradient-purple text-white text-sm font-semibold px-4 py-2 rounded-xl disabled:opacity-50"
        >
          <Save size={15} /> Save login settings
        </button>
      </div>

      <p className="text-xs text-muted-foreground mb-4">
        Off karne se button app ke login aur signup dono screens se gayab ho jata hai, aur us tarike se naya account nahi banega
        (server bhi rokta hai). Phone OTP off karne par code bhejna hi band ho jata hai. Jo users pehle se logged in hain, unka session chalta rahega.
      </p>

      {/* Master switch */}
      <div className="rounded-xl border border-border p-3 mb-4">
        <button
          onClick={() => setM({ ...m, signupsEnabled: !m.signupsEnabled })}
          className="flex items-center justify-between w-full text-left"
        >
          <span className="text-sm font-semibold text-foreground">Naye signups allow karo (master switch)</span>
          <Pill on={m.signupsEnabled} />
        </button>
        {!m.signupsEnabled && (
          <>
            <p className="text-xs text-amber-700 mt-2">Purane users login kar sakenge; naya account koi nahi bana payega.</p>
            <input
              className="w-full mt-2 px-3 py-2 rounded-xl border border-border bg-background text-sm"
              placeholder="Users ko dikhne wala message"
              value={m.signupsClosedMessage}
              maxLength={200}
              onChange={(e) => setM({ ...m, signupsClosedMessage: e.target.value })}
            />
          </>
        )}
      </div>

      {/* Per method */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground text-left">
              <th className="py-2 pr-2 font-medium">Method</th>
              <th className="py-2 px-2 font-medium text-center">On</th>
              {PLATFORMS.map((p) => (
                <th key={p} className="py-2 px-2 font-medium text-center capitalize">
                  {p === "ios" ? "iOS" : p}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROWS.map(({ key, label, hint }) => (
              <tr key={key} className="border-t border-border align-top">
                <td className="py-2.5 pr-2">
                  <div className="font-medium text-foreground">{label}</div>
                  {hint && m[key].enabled && <div className="text-[11px] text-muted-foreground mt-0.5 max-w-xs">{hint}</div>}
                </td>
                <td className="py-2.5 px-2 text-center">
                  <button onClick={() => set(key, { enabled: !m[key].enabled })} aria-label={`${label} on/off`}>
                    <Pill on={m[key].enabled} />
                  </button>
                </td>
                {PLATFORMS.map((p) => (
                  <td key={p} className="py-2.5 px-2 text-center">
                    <input
                      type="checkbox"
                      className="w-4 h-4 accent-violet-500"
                      disabled={!m[key].enabled}
                      checked={m[key][p]}
                      onChange={(e) => set(key, { [p]: e.target.checked } as Partial<Switch>)}
                      aria-label={`${label} on ${p}`}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {lockedOut.length > 0 && (
        <div className="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2 mt-3">
          <AlertTriangle size={14} className="mt-px shrink-0" />
          <span>{lockedOut.join(", ")} par koi login tarika on nahi hai — users login nahi kar payenge. Save nahi hoga.</span>
        </div>
      )}

      {/* Sign-ups by method */}
      <div className="mt-5">
        <div className="text-xs font-semibold text-muted-foreground mb-2">Pichhle 30 din ke naye signups (method ke hisaab se)</div>
        {stats.length === 0 ? (
          <div className="text-xs text-muted-foreground">Abhi koi data nahi.</div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {stats.map((s) => (
              <span key={s.provider} className="text-xs bg-secondary text-foreground rounded-full px-3 py-1">
                {PROVIDER_LABEL[s.provider] || s.provider}: <b>{s.count}</b>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Pill({ on }: { on: boolean }) {
  return (
    <span className={`relative inline-block w-10 h-6 rounded-full transition-colors align-middle ${on ? "bg-violet-500" : "bg-secondary"}`}>
      <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${on ? "translate-x-4" : ""}`} />
    </span>
  );
}

export default AuthMethodsCard;
