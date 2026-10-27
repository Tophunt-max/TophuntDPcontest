import { useState } from "react";

/**
 * Approval-password prompt for promo actions (budgets, budget-funded packages
 * and contest prizes). Shown when the Worker answers `approval_required` or
 * `approval_invalid`; resolves with the typed password (the request is then
 * re-sent with it) or null when cancelled. The panel never stores it.
 */
export function ApprovalDialog({
  invalid,
  onSubmit,
  onCancel,
}: {
  invalid: boolean;
  onSubmit: (password: string) => void;
  onCancel: () => void;
}) {
  const [password, setPassword] = useState("");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (password) onSubmit(password);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/50" role="dialog" aria-modal="true" aria-labelledby="approval-title">
      <form onSubmit={submit} className="bg-card border border-border rounded-2xl p-6 w-full max-w-sm">
        <h3 id="approval-title" className="font-bold text-foreground mb-1">Approval password</h3>
        <p className="text-sm text-muted-foreground mb-4">
          Is action se platform apni taraf se coin dega. Confirm karne ke liye approval password dalo.
        </p>
        <input
          type="password"
          autoFocus
          autoComplete="off"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-label="Approval password"
          className="w-full px-3 py-2.5 rounded-xl border border-border bg-background text-sm mb-2 focus:outline-none focus:ring-2 focus:ring-ring"
        />
        {invalid && <p className="text-sm text-red-600 mb-2">Approval password galat hai. Dobara dalo.</p>}
        <div className="flex gap-2 mt-2">
          <button type="button" onClick={onCancel} className="flex-1 py-2.5 rounded-xl bg-secondary text-foreground text-sm font-medium">
            Cancel
          </button>
          <button type="submit" disabled={!password} className="flex-1 py-2.5 rounded-xl gradient-purple text-white text-sm font-semibold disabled:opacity-50">
            Approve
          </button>
        </div>
      </form>
    </div>
  );
}
