import { QrCode, CreditCard, Landmark, Wallet } from "lucide-react";

/** Segmented status-filter tabs used by the finance pages. */
export function SegTabs({
  tab,
  setTab,
  tabs,
}: {
  tab: string;
  setTab: (k: string) => void;
  tabs: { key: string; label: string }[];
}) {
  return (
    <div className="flex gap-1 mb-4 bg-secondary/50 p-1 rounded-xl w-fit">
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => setTab(t.key)}
          className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
            tab === t.key ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** User cell with an initials avatar. */
export function UserCell({ name, sub }: { name: string; sub?: string }) {
  const initials = (name || "?").trim().slice(0, 2).toUpperCase();
  return (
    <div className="flex items-center gap-3 min-w-0">
      <div className="w-9 h-9 rounded-full gradient-purple flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
        {initials}
      </div>
      <div className="min-w-0">
        <p className="font-medium text-foreground truncate">{name}</p>
        {sub && <p className="text-xs text-muted-foreground truncate font-mono">{sub}</p>}
      </div>
    </div>
  );
}

/** Payment-method pill with a contextual icon. */
export function MethodBadge({ method }: { method: string }) {
  const m = (method || "").toLowerCase();
  const icon =
    m.includes("upi") || m.includes("qr") ? (
      <QrCode size={11} />
    ) : m.includes("razor") || m.includes("auto") || m.includes("card") ? (
      <CreditCard size={11} />
    ) : m.includes("bank") ? (
      <Landmark size={11} />
    ) : (
      <Wallet size={11} />
    );
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-blue-100 text-blue-700">
      {icon}
      {method || "—"}
    </span>
  );
}

/** Compact colored action button (approve / reject / paid). */
export function ActionBtn({
  children,
  title,
  onClick,
  tone = "green",
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
  tone?: "green" | "red" | "blue";
}) {
  const tones: Record<string, string> = {
    green: "text-green-700 bg-green-50 hover:bg-green-100",
    red: "text-red-700 bg-red-50 hover:bg-red-100",
    blue: "text-blue-700 bg-blue-50 hover:bg-blue-100",
  };
  return (
    <button
      title={title}
      onClick={onClick}
      className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-colors ${tones[tone]}`}
    >
      {children}
    </button>
  );
}
