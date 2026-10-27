import { Link } from "wouter";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { PageHeader } from "@/lib/format";
import { toast } from "@/lib/toast";
import {
  Save,
  Coins,
  Megaphone,
  Mail,
  Code2,
  AlertTriangle,
  ChevronDown,
} from "lucide-react";

/**
 * App Settings — the operational knobs that used to be a raw JSON textarea.
 *
 * A JSON editor is fine for a developer and hostile to everyone else: no
 * validation, no discoverability, and one stray comma away from breaking wallet
 * limits in production.
 *
 * Two rules this page follows:
 *
 *  1. UNKNOWN KEYS ARE PRESERVED. The Worker merges the posted object into the
 *     stored one, and the "Advanced" section below still exposes everything the
 *     form does not model, so saving here can never silently drop a setting a
 *     future version added.
 *  2. Machine-critical settings (maintenance mode, feature flags) live on the App
 *     Control page. This page is money, legal and messaging.
 */

const field =
  "w-full px-3 py-2.5 rounded-xl border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring";
const label = "block text-xs font-semibold text-muted-foreground mb-1.5 uppercase tracking-wide";
const hint = "text-[11px] text-muted-foreground mt-1";

/** Keys this form owns. Anything else is shown in the Advanced JSON section. */
const MANAGED_KEYS = [
  // Legacy: the signup bonus is gone and the referral reward moved to the
  // Referrals page (`referralProgram`). Kept here so it is never re-posted.
  "rewardSettings",
  // Owned by the Referrals page.
  "referralProgram",
  // Owned by the Explore page.
  "explore",
  // Owned by the Feed Ranking page (validated + audited there).
  "feedWeights",
  "verificationReward",
  "paymentGateway",
  "ads",
  "adminAlertEmail",
  "supportEmail",
  "legalContent",
  "socialLinks",
  // Edited on the Onboarding page; kept out of Advanced so a save here can
  // never re-post a stale copy over it.
  "onboarding",
  "onboardingEnabled",
  // Owned by App Control (live switches). Never re-posted from this page: a
  // stale copy here would silently undo maintenance / flags / banner changes.
  "maintenanceMode",
  "maintenanceMessage",
  "maintenanceEta",
  "maintenanceSchedule",
  "forceUpdate",
  "forceUpdateMode",
  "minAppVersion",
  "updateUrls",
  "updateUrl",
  "updateMessage",
  "announcement",
  "features",
  "authMethods",
  // Free-reward locking: owned by Coin Economy → Earn.
  "rewardLocking",
  // Withdrawals & payouts and coin pricing are money settings owned ONLY by the
  // Coin Economy hub. Not editable here, and never re-posted from this page — a stale copy
  // could silently undo a payout freeze or re-price the store.
  "withdrawal",
  "coinPricing",
  // Server-stamped.
  "_version",
];

/** The keys THIS form edits and sends. Everything else is left untouched server-side. */
const FORM_KEYS = [
  "adminAlertEmail",
  "supportEmail",
  "socialLinks",
] as const;

interface VerificationRewardCfg {
  enabled: boolean;
  registrationReward: number;
  completionReward: number;
  maxTotalReward: number;
  requireEmail: boolean;
  requirePhone: boolean;
  initialReminderDays: number;
  repeatReminderDays: number;
  maxReminders: number;
  emailResendCooldownSec: number;
  smsResendCooldownSec: number;
}

interface Cfg {
  verificationReward: VerificationRewardCfg;
  paymentGateway: { mode: "auto" | "manual" | "both" };
  ads: { enabled: boolean; trustClient: boolean; provider: string; reward: number; dailyCap: number };
  adminAlertEmail: string;
  supportEmail: string;
  // NOTE: legal documents are managed on their OWN page (/legal), not here — this
  // page must never send `legalContent`, or an unrelated save would wipe an
  // override. It stays in MANAGED_KEYS above so it is also kept out of the Advanced
  // JSON editor.
  socialLinks: { instagram: string; youtube: string; telegram: string; website: string };
}

const DEFAULTS: Cfg = {
  // Mirrors VERIFICATION_REWARD_DEFAULTS in apps/worker/src/lib/verificationReward.ts.
  // The Worker is authoritative and re-validates everything on save.
  verificationReward: {
    enabled: true,
    // There is no signup bonus any more; always 0 (the Worker enforces it too).
    registrationReward: 0,
    completionReward: 90,
    maxTotalReward: 100,
    requireEmail: true,
    requirePhone: true,
    initialReminderDays: 3,
    repeatReminderDays: 7,
    maxReminders: 5,
    emailResendCooldownSec: 60,
    smsResendCooldownSec: 60,
  },
  paymentGateway: { mode: "auto" },
  ads: { enabled: false, trustClient: false, provider: "", reward: 5, dailyCap: 10 },
  adminAlertEmail: "",
  supportEmail: "",
  socialLinks: { instagram: "", youtube: "", telegram: "", website: "" },
};

function Section({
  icon: Icon,
  title,
  blurb,
  children,
}: {
  icon: any;
  title: string;
  blurb?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-card border border-border rounded-2xl p-5">
      <div className="flex items-start gap-3 mb-4">
        <div className="w-9 h-9 rounded-xl bg-secondary flex items-center justify-center shrink-0">
          <Icon size={17} />
        </div>
        <div>
          <h3 className="font-bold text-foreground leading-tight">{title}</h3>
          {blurb && <p className="text-xs text-muted-foreground mt-0.5">{blurb}</p>}
        </div>
      </div>
      {children}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  title,
  description,
  danger,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  title: string;
  description?: string;
  danger?: boolean;
}) {
  return (
    <label className="flex items-start justify-between gap-4 py-2.5 cursor-pointer">
      <span>
        <span className={`text-sm font-medium ${danger && checked ? "text-red-600" : "text-foreground"}`}>{title}</span>
        {description && <span className="block text-xs text-muted-foreground mt-0.5">{description}</span>}
      </span>
      <span className="relative shrink-0 mt-0.5">
        <input type="checkbox" className="sr-only peer" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span
          className={`block w-10 h-6 rounded-full transition-colors ${
            checked ? (danger ? "bg-red-500" : "bg-primary") : "bg-secondary border border-border"
          }`}
        />
        <span
          className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white shadow transition-transform ${
            checked ? "translate-x-4" : ""
          }`}
        />
      </span>
    </label>
  );
}

export default function AppSettings() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["app-settings"], queryFn: api.appSettings });
  const [cfg, setCfg] = useState<Cfg>(DEFAULTS);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [advancedText, setAdvancedText] = useState("");
  const [advancedErr, setAdvancedErr] = useState<string | null>(null);

  // Everything the form does not model, so a save can never drop it.
  const unmanaged = useMemo(() => {
    if (!data || typeof data !== "object") return {};
    return Object.fromEntries(Object.entries(data).filter(([k]) => !MANAGED_KEYS.includes(k)));
  }, [data]);

  useEffect(() => {
    if (!data) return;
    setCfg({
      ...DEFAULTS,
      ...data,
      verificationReward: { ...DEFAULTS.verificationReward, ...(data.verificationReward || {}), registrationReward: 0 },
      paymentGateway: { ...DEFAULTS.paymentGateway, ...(data.paymentGateway || {}) },
      ads: { ...DEFAULTS.ads, ...(data.ads || {}) },
      socialLinks: { ...DEFAULTS.socialLinks, ...(data.socialLinks || {}) },
    });
    setAdvancedText(JSON.stringify(unmanaged, null, 2));
  }, [data, unmanaged]);

  const saveMut = useMutation({
    mutationFn: (payload: any) => api.saveAppSettings(payload),
    onSuccess: () => {
      toast.success("App settings saved");
      qc.invalidateQueries({ queryKey: ["app-settings"] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const onSave = () => {
    let advanced: any = {};
    if (advancedText.trim()) {
      try {
        advanced = JSON.parse(advancedText);
      } catch (e: any) {
        setAdvancedErr(`Advanced JSON is invalid: ${e.message}`);
        setAdvancedOpen(true);
        return;
      }
    }
    setAdvancedErr(null);
    // Only this form's keys (plus Advanced extras): the Worker merges, so
    // nothing owned by another page — legal text, onboarding, App Control's live
    // switches — is re-posted from a stale copy. Structured fields win.
    const own = Object.fromEntries(FORM_KEYS.map((k) => [k, (cfg as any)[k]]));
    const extras = Object.fromEntries(Object.entries(advanced).filter(([k]) => !MANAGED_KEYS.includes(k)));
    saveMut.mutate({ ...extras, ...own });
  };

  if (isLoading) return <div className="text-sm text-muted-foreground py-10 text-center">Loading…</div>;


  return (
    <div>
      <PageHeader
        title="App Settings"
        subtitle="Contact details, social links aur advanced settings (coin settings: Coin Economy)"
        action={
          <button
            onClick={onSave}
            disabled={saveMut.isPending}
            className="flex items-center gap-2 gradient-purple text-white text-sm font-semibold px-4 py-2 rounded-xl shadow-lg disabled:opacity-50"
          >
            <Save size={15} /> Save
          </button>
        }
      />

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        {/* ---- Coins: owned by Coin Economy ---- */}
        <Section icon={Coins} title="Coins & rewards" blurb="Ab sab ek jagah: Coin Economy.">
          <p className="text-sm text-muted-foreground">
            Verification bonus, referral, daily login, daily tasks, rewarded ads, Hall of Fame, withdrawals, buy rate aur payment
            gateway{" "}
            <Link href="/coin-economy" className="font-semibold text-foreground underline">Coin Economy</Link> (Earn, Buy aur Cash out
            tabs) mein set hote hain.
          </p>
        </Section>

        {/* ---- Contact ---- */}
        <Section icon={Mail} title="Contact & alerts" blurb="Where operational email goes.">
          <div className="grid grid-cols-1 gap-3">
            <div>
              <label className={label}>Admin alert email (private)</label>
              <input
                type="email"
                value={cfg.adminAlertEmail}
                onChange={(e) => setCfg({ ...cfg, adminAlertEmail: e.target.value })}
                placeholder="ops@tophunt.in"
                className={field}
              />
              <p className={hint}>Receives withdrawal-request and deposit alerts. Never exposed to the app.</p>
            </div>
            <div>
              <label className={label}>Public support email</label>
              <input
                type="email"
                value={cfg.supportEmail}
                onChange={(e) => setCfg({ ...cfg, supportEmail: e.target.value })}
                placeholder="support@tophunt.in"
                className={field}
              />
              <p className={hint}>Shown in the app's help screens.</p>
            </div>
          </div>
        </Section>

        {/* ---- Social ---- */}
        <Section icon={Megaphone} title="Social links" blurb="Rendered in the app's about/help screens.">
          <div className="grid grid-cols-2 gap-3">
            {(["instagram", "youtube", "telegram", "website"] as const).map((k) => (
              <div key={k}>
                <label className={label}>{k}</label>
                <input
                  value={cfg.socialLinks[k]}
                  onChange={(e) => setCfg({ ...cfg, socialLinks: { ...cfg.socialLinks, [k]: e.target.value } })}
                  placeholder="https://…"
                  className={field}
                />
              </div>
            ))}
          </div>
        </Section>
      </div>

      {/* Legal documents moved to their own page (/legal): they are long-form,
          need a filled editor (bundled default vs override) and per-document save,
          and must not ride this page's all-at-once save. */}

      {/* ---- Advanced ---- */}
      <div className="mt-5 bg-card border border-border rounded-2xl overflow-hidden">
        <button
          onClick={() => setAdvancedOpen((v) => !v)}
          className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-secondary/40 transition-colors"
        >
          <span className="flex items-center gap-3">
            <span className="w-9 h-9 rounded-xl bg-secondary flex items-center justify-center">
              <Code2 size={17} />
            </span>
            <span>
              <span className="block font-bold text-foreground leading-tight">Advanced</span>
              <span className="block text-xs text-muted-foreground mt-0.5">
                Any setting not covered by the form above ({Object.keys(unmanaged).length} key
                {Object.keys(unmanaged).length === 1 ? "" : "s"}). Editing is optional — these are preserved on save
                either way.
              </span>
            </span>
          </span>
          <ChevronDown size={18} className={`transition-transform ${advancedOpen ? "rotate-180" : ""}`} />
        </button>
        {advancedOpen && (
          <div className="px-5 pb-5">
            {advancedErr && (
              <div className="flex items-center gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2 mb-3">
                <AlertTriangle size={16} /> {advancedErr}
              </div>
            )}
            <textarea
              value={advancedText}
              onChange={(e) => setAdvancedText(e.target.value)}
              spellCheck={false}
              rows={14}
              className={`${field} font-mono text-xs leading-relaxed`}
            />
            <p className={hint}>
              Fields owned by the form above always win, so you cannot contradict the UI from here.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
