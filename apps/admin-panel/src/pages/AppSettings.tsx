import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { PageHeader } from "@/lib/format";
import { toast } from "@/lib/toast";
import {
  Save,
  Coins,
  Banknote,
  CreditCard,
  Megaphone,
  Mail,
  Scale,
  Code2,
  AlertTriangle,
  ChevronDown,
  Tv,
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
  "rewardSettings",
  "withdrawal",
  "paymentGateway",
  "ads",
  "adminAlertEmail",
  "supportEmail",
  "legalContent",
  "socialLinks",
];

interface Cfg {
  rewardSettings: { signupBonus: number; referralBonus: number };
  withdrawal: {
    enabled: boolean;
    payoutsFrozen: boolean;
    minAmount: number;
    maxAmount: number;
    maxPerDay: number;
    conversionRate: number;
  };
  paymentGateway: { mode: "auto" | "manual" | "both" };
  ads: { enabled: boolean; trustClient: boolean; provider: string; reward: number; dailyCap: number };
  adminAlertEmail: string;
  supportEmail: string;
  legalContent: {
    privacyPolicy: string;
    termsOfService: string;
    refundPolicy: string;
    communityGuidelines: string;
  };
  socialLinks: { instagram: string; youtube: string; telegram: string; website: string };
}

const DEFAULTS: Cfg = {
  rewardSettings: { signupBonus: 100, referralBonus: 50 },
  withdrawal: {
    enabled: true,
    payoutsFrozen: false,
    minAmount: 100,
    maxAmount: 0,
    maxPerDay: 0,
    conversionRate: 1,
  },
  paymentGateway: { mode: "auto" },
  ads: { enabled: false, trustClient: false, provider: "", reward: 5, dailyCap: 10 },
  adminAlertEmail: "",
  supportEmail: "",
  legalContent: { privacyPolicy: "", termsOfService: "", refundPolicy: "", communityGuidelines: "" },
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
      rewardSettings: { ...DEFAULTS.rewardSettings, ...(data.rewardSettings || {}) },
      withdrawal: { ...DEFAULTS.withdrawal, ...(data.withdrawal || {}) },
      paymentGateway: { ...DEFAULTS.paymentGateway, ...(data.paymentGateway || {}) },
      ads: { ...DEFAULTS.ads, ...(data.ads || {}) },
      legalContent: { ...DEFAULTS.legalContent, ...(data.legalContent || {}) },
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
    // Advanced first so the structured fields always win for keys they own.
    saveMut.mutate({ ...advanced, ...cfg });
  };

  if (isLoading) return <div className="text-sm text-muted-foreground py-10 text-center">Loading…</div>;

  const num = (v: string) => (v === "" ? 0 : Number(v));
  const cashPreview = cfg.withdrawal.minAmount * cfg.withdrawal.conversionRate;

  return (
    <div>
      <PageHeader
        title="App Settings"
        subtitle="Wallet rules, payment mode, rewarded ads, legal copy and contact details"
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
        {/* ---- Rewards ---- */}
        <Section icon={Coins} title="Joining & referral rewards" blurb="Coins granted automatically.">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label}>Signup bonus (coins)</label>
              <input
                type="number"
                min={0}
                value={cfg.rewardSettings.signupBonus}
                onChange={(e) =>
                  setCfg({ ...cfg, rewardSettings: { ...cfg.rewardSettings, signupBonus: num(e.target.value) } })
                }
                className={field}
              />
            </div>
            <div>
              <label className={label}>Referral bonus (coins)</label>
              <input
                type="number"
                min={0}
                value={cfg.rewardSettings.referralBonus}
                onChange={(e) =>
                  setCfg({ ...cfg, rewardSettings: { ...cfg.rewardSettings, referralBonus: num(e.target.value) } })
                }
                className={field}
              />
            </div>
          </div>
        </Section>

        {/* ---- Payment mode ---- */}
        <Section
          icon={CreditCard}
          title="Deposit method"
          blurb="How users buy coins. Manual mode accepts a UPI reference for admin approval."
        >
          <label className={label}>Mode</label>
          <select
            value={cfg.paymentGateway.mode}
            onChange={(e) => setCfg({ ...cfg, paymentGateway: { mode: e.target.value as any } })}
            className={field}
          >
            <option value="auto">Automatic only (Razorpay checkout)</option>
            <option value="manual">Manual only (UPI/QR + admin approval)</option>
            <option value="both">Both</option>
          </select>
          <p className={hint}>
            Automatic mode requires the Razorpay credentials on the Integrations page. Manual deposits are
            priced from the coin packages, never from a client-supplied amount.
          </p>
        </Section>

        {/* ---- Withdrawals ---- */}
        <Section icon={Banknote} title="Withdrawals & payouts" blurb="Limits enforced server-side on every request.">
          <Toggle
            checked={cfg.withdrawal.enabled}
            onChange={(v) => setCfg({ ...cfg, withdrawal: { ...cfg.withdrawal, enabled: v } })}
            title="Withdrawals enabled"
            description="Turn off to hide the payout flow entirely."
          />
          <Toggle
            danger
            checked={cfg.withdrawal.payoutsFrozen}
            onChange={(v) => setCfg({ ...cfg, withdrawal: { ...cfg.withdrawal, payoutsFrozen: v } })}
            title="Freeze payouts (emergency)"
            description="Blocks all new payout requests immediately without disabling the feature. Use during a suspected-fraud incident."
          />
          <div className="grid grid-cols-2 gap-3 mt-3">
            <div>
              <label className={label}>Minimum per request</label>
              <input
                type="number"
                min={0}
                value={cfg.withdrawal.minAmount}
                onChange={(e) => setCfg({ ...cfg, withdrawal: { ...cfg.withdrawal, minAmount: num(e.target.value) } })}
                className={field}
              />
            </div>
            <div>
              <label className={label}>Maximum per request</label>
              <input
                type="number"
                min={0}
                value={cfg.withdrawal.maxAmount}
                onChange={(e) => setCfg({ ...cfg, withdrawal: { ...cfg.withdrawal, maxAmount: num(e.target.value) } })}
                className={field}
              />
              <p className={hint}>0 = no limit (not recommended).</p>
            </div>
            <div>
              <label className={label}>Maximum per 24 hours</label>
              <input
                type="number"
                min={0}
                value={cfg.withdrawal.maxPerDay}
                onChange={(e) => setCfg({ ...cfg, withdrawal: { ...cfg.withdrawal, maxPerDay: num(e.target.value) } })}
                className={field}
              />
              <p className={hint}>Rolling window across all requests. 0 = no limit.</p>
            </div>
            <div>
              <label className={label}>Coins → ₹ rate</label>
              <input
                type="number"
                min={0}
                step="0.01"
                value={cfg.withdrawal.conversionRate}
                onChange={(e) =>
                  setCfg({ ...cfg, withdrawal: { ...cfg.withdrawal, conversionRate: num(e.target.value) } })
                }
                className={field}
              />
              <p className={hint}>
                {cfg.withdrawal.minAmount} coins = ₹{cashPreview.toFixed(2)}
              </p>
            </div>
          </div>
        </Section>

        {/* ---- Rewarded ads ---- */}
        <Section icon={Tv} title="Rewarded ads" blurb="Coins for watching an ad. Off by default, for good reason.">
          <Toggle
            checked={cfg.ads.enabled}
            onChange={(v) => setCfg({ ...cfg, ads: { ...cfg.ads, enabled: v } })}
            title="Rewarded ads enabled"
          />
          {cfg.ads.enabled && (
            <div className="flex items-start gap-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 my-2">
              <AlertTriangle size={14} className="mt-px shrink-0" />
              <span>
                A rewarded ad mints withdrawable currency. Unless the ad network's server-side verification
                (SSV) callback is what credits the coins, the app is trusting the client's word that an ad
                was watched. Only enable "trust client" knowingly.
              </span>
            </div>
          )}
          {cfg.ads.enabled && (
            <>
              <Toggle
                danger
                checked={cfg.ads.trustClient}
                onChange={(v) => setCfg({ ...cfg, ads: { ...cfg.ads, trustClient: v } })}
                title="Credit without server-side verification"
                description="Required for providers with no SSV. Keep the daily cap low if you enable this."
              />
              <div className="grid grid-cols-3 gap-3 mt-3">
                <div>
                  <label className={label}>Provider</label>
                  <input
                    value={cfg.ads.provider}
                    onChange={(e) => setCfg({ ...cfg, ads: { ...cfg.ads, provider: e.target.value } })}
                    placeholder="admob"
                    className={field}
                  />
                </div>
                <div>
                  <label className={label}>Coins per ad</label>
                  <input
                    type="number"
                    min={1}
                    value={cfg.ads.reward}
                    onChange={(e) => setCfg({ ...cfg, ads: { ...cfg.ads, reward: num(e.target.value) } })}
                    className={field}
                  />
                </div>
                <div>
                  <label className={label}>Daily cap</label>
                  <input
                    type="number"
                    min={1}
                    value={cfg.ads.dailyCap}
                    onChange={(e) => setCfg({ ...cfg, ads: { ...cfg.ads, dailyCap: num(e.target.value) } })}
                    className={field}
                  />
                </div>
              </div>
            </>
          )}
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

      {/* ---- Legal ---- */}
      <div className="mt-5">
        <Section
          icon={Scale}
          title="Legal content"
          blurb="Overrides only. Leave a box empty and the app serves the document bundled with the Worker (apps/worker/src/content/legal.ts) — so a policy is never blank. Clearing a box reverts to the bundled text."
        >
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {(
              [
                ["privacyPolicy", "Privacy Policy", "Required by both app stores."],
                ["termsOfService", "Terms of Service", "Include contest rules and eligibility."],
                ["refundPolicy", "Refund & Cancellation Policy", "Required by Razorpay for paid digital goods."],
                ["communityGuidelines", "Community Guidelines", "Referenced from the in-app report flow."],
              ] as const
            ).map(([key, title, help]) => (
              <div key={key}>
                <label className={label}>{title}</label>
                <textarea
                  value={cfg.legalContent[key]}
                  onChange={(e) => setCfg({ ...cfg, legalContent: { ...cfg.legalContent, [key]: e.target.value } })}
                  rows={10}
                  className={`${field} font-mono text-xs leading-relaxed`}
                  /*
                   * The supported syntax, stated exactly. This said "Markdown or
                   * plain text…" while the app rendered the whole document inside a
                   * single Text node, so anything written as Markdown reached users
                   * as literal asterisks. The app now has a renderer, but it
                   * understands this subset and nothing more — links, tables and
                   * code fences will show as written.
                   */
                  placeholder={"## Heading\n\nParagraph text with **bold** runs.\n\n- bullet\n- bullet"}
                />
                <p className={hint}>
                  {help}{" "}
                  {cfg.legalContent[key]
                    ? `Overriding the bundled document — ${cfg.legalContent[key].length} characters.`
                    : "Using the bundled document."}
                </p>
              </div>
            ))}
          </div>
        </Section>
      </div>

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
