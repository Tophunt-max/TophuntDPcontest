import { useState } from "react";

/**
 * Password prompt for "sudo mode": shown when the Worker refuses a sensitive
 * action because the sign-in is older than its window. Resolves the pending
 * request via `onSubmit` (re-authenticate, then retry) or `onCancel`.
 */
export function ReauthDialog({
  email,
  onSubmit,
  onCancel,
}: {
  email: string | null;
  onSubmit: (password: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(password);
    } catch (err: any) {
      setError(/wrong-password|invalid-credential/i.test(String(err?.code || err?.message)) ? "Wrong password." : "Could not confirm. Try again.");
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/50" role="dialog" aria-modal="true" aria-labelledby="reauth-title">
      <form onSubmit={submit} className="bg-card border border-border rounded-2xl p-6 w-full max-w-sm">
        <h3 id="reauth-title" className="font-bold text-foreground mb-1">Confirm it's you</h3>
        <p className="text-sm text-muted-foreground mb-4">
          This action needs a recent sign-in. Enter the password for {email || "your account"}.
        </p>
        <input
          type="password"
          autoFocus
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-label="Password"
          className="w-full px-3 py-2.5 rounded-xl border border-border bg-background text-sm mb-2 focus:outline-none focus:ring-2 focus:ring-ring"
        />
        {error && <p className="text-sm text-red-600 mb-2">{error}</p>}
        <div className="flex gap-2 mt-2">
          <button type="button" onClick={onCancel} className="flex-1 py-2.5 rounded-xl bg-secondary text-foreground text-sm font-medium">
            Cancel
          </button>
          <button type="submit" disabled={!password || busy} className="flex-1 py-2.5 rounded-xl gradient-purple text-white text-sm font-semibold disabled:opacity-50">
            Confirm
          </button>
        </div>
      </form>
    </div>
  );
}
