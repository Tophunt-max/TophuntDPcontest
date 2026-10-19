import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Table } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { StatCard } from "@/components/ui/StatCard";
import { PageHeader, fmtDateTime, fmtNumber, exportCsv } from "@/lib/format";
import { useConfirm } from "@/components/ConfirmDialog";
import { toast } from "@/lib/toast";
import { SegTabs, UserCell, ActionBtn } from "@/components/finance/bits";
import { Check, X, Download, Save, Plus, Trash2, Users, Hourglass, Coins, ShieldAlert, Trophy, AlertTriangle } from "lucide-react";

/**
 * Referral program — the whole thing, managed here.
 *
 * Settings are stored as `appConfig.referralProgram` and validated by the Worker
 * (lib/referralProgram.ts). A referral pays BOTH sides, but only once the invited
 * friend completes the qualifying action; until then it is `pending`. There is no
 * signup bonus: this is the only way a new user earns coins for joining.
 */

type QualifyAction = "signup" | "verified" | "first_contest" | "first_purchase";

interface Program {
  enabled: boolean;
  referrerReward: number;
  refereeReward: number;
  qualifyAction: QualifyAction;
  applyWindowDays: number;
  qualifyWindowDays: number;
  maxRewardedPerReferrer: number;
  maxRewardedPerReferrerPerDay: number;
  requireReview: boolean;
  milestones: { count: number; bonus: number }[];
}

const DEFAULTS: Program = {
  enabled: true,
  referrerReward: 50,
  refereeReward: 50,
  qualifyAction: "first_contest",
  applyWindowDays: 7,
  qualifyWindowDays: 30,
  maxRewardedPerReferrer: 0,
  maxRewardedPerReferrerPerDay: 20,
  requireReview: false,
  milestones: [],
};

const ACTIONS: { k: QualifyAction; l: string; d: string }[] = [
  { k: "first_contest", l: "First contest entry", d: "Recommended. Paid when the friend joins their first contest." },
  { k: "first_purchase", l: "First coin purchase", d: "Strongest anti-fraud: paid after the friend's first paid top-up." },
  { k: "verified", l: "Email + mobile verified", d: "Paid once the friend verifies BOTH email and mobile." },
  { k: "signup", l: "Signup (instant)", d: "Paid as soon as the friend signs up. Easiest to farm — not recommended." },
];

const ACTION_LABEL: Record<string, string> = Object.fromEntries(ACTIONS.map((a) => [a.k, a.l]));

const TABS = [
  { key: "", label: "All" },
  { key: "pending", label: "Pending" },
  { key: "review", label: "Needs review" },
  { key: "rewarded", label: "Rewarded" },
  { key: "rejected", label: "Rejected" },
  { key: "expired", label: "Expired" },
];

const REASONS: Record<string, string> = {
  same_device_as_referrer: "Same device as the inviter",
  device_already_used: "Device already used for a referral",
  referrer_lifetime_cap: "Inviter hit the lifetime cap (friend still paid)",
  referrer_daily_cap: "Inviter hit the daily cap (friend still paid)",
  referrer_unavailable: "Inviter blocked / inactive (friend still paid)",
  admin_rejected: "Rejected by an admin",
};

const STATUS_VARIANT: Record<string, string> = {
  pending: "pending",
  review: "info",
  rewarded: "success",
  rejected: "danger",
  expired: "default",
};

const field =
  "w-full px-3 py-2.5 rounded-xl border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring";
const label = "block text-xs font-semibold text-muted-foreground mb-1.5 uppercase tracking-wide";
const hint = "text-[11px] text-muted-foreground mt-1";

function validate(p: Program): string | null {
  const ints: [string, number, number, number][] = [
    ["Inviter reward", p.referrerReward, 0, 100_000],
    ["Friend reward", p.refereeReward, 0, 100_000],
    ["Code apply window", p.applyWindowDays, 0, 90],
    ["Qualify window", p.qualifyWindowDays, 1, 365],
    ["Lifetime cap", p.maxRewardedPerReferrer, 0, 100_000],
    ["Daily cap", p.maxRewardedPerReferrerPerDay, 0, 10_000],
  ];
  for (const [name, n, lo, hi] of ints) {
    if (!Number.isInteger(n) || n < lo || n > hi) return `${name} must be a whole number from ${lo} to ${hi}.`;
  }
  const seen = new Set<number>();
  for (const [i, m] of p.milestones.entries()) {
    if (!Number.isInteger(m.count) || m.count < 1) return `Milestone ${i + 1}: referrals must be at least 1.`;
    if (!Number.isInteger(m.bonus) || m.bonus < 1 || m.bonus > 100_000) return `Milestone ${i + 1}: bonus must be 1–100000 coins.`;
    if (seen.has(m.count)) return `Milestone ${i + 1}: two tiers at ${m.count} referrals.`;
    seen.add(m.count);
  }
  if (p.milestones.length > 20) return "At most 20 milestones.";
  return null;
}

function Toggle({ checked, onChange, title, description }: { checked: boolean; onChange: (v: boolean) => void; title: string; description?: string }) {
  return (
    <label className="flex items-start justify-between gap-4 py-2.5 cursor-pointer">
      <span>
        <span className="text-sm font-medium text-foreground">{title}</span>
        {description && <span className="block text-xs text-muted-foreground mt-0.5">{description}</span>}
      </span>
      <span className="relative shrink-0 mt-0.5">
        <input type="checkbox" className="sr-only peer" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className={`block w-10 h-6 rounded-full transition-colors ${checked ? "bg-primary" : "bg-secondary border border-border"}`} />
        <span className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-4" : ""}`} />
      </span>
    </label>
  );
}

export default function Referrals() {
  const qc = useQueryClient();
  const { confirm } = useConfirm();
  const [tab, setTab] = useState("");
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setSearch(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const { data, isLoading } = useQuery({
    queryKey: ["referrals", tab, search],
    queryFn: () => api.referrals({ status: tab || undefined, q: search || undefined }),
  });
  const rows = data?.rows ?? [];
  const by = data?.stats?.byStatus ?? {};
  const total = Object.values(by).reduce((t: number, n: any) => t + (Number(n) || 0), 0);

  const decideMut = useMutation({
    mutationFn: ({ id, action, reason }: { id: string; action: "approve" | "reject"; reason?: string }) => api.decideReferral(id, action, reason),
    onSuccess: (_r, v) => {
      toast.success(v.action === "approve" ? "Referral approved & paid" : "Referral rejected");
      qc.invalidateQueries({ queryKey: ["referrals"] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <div>
      <PageHeader
        title="Referral Program"
        subtitle="Invite & earn — both sides paid once the friend qualifies. There is no signup bonus."
        action={
          <button
            onClick={() =>
              exportCsv(`referrals-${Date.now()}.csv`, rows, [
                "id", "referrerUsername", "referrerUid", "referredUsername", "referredUid", "code", "status",
                "qualifyAction", "referrerReward", "refereeReward", "rejectReason", "deviceId", "createdAt", "qualifiedAt", "rewardedAt", "expiresAt",
              ])
            }
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-secondary text-sm font-medium hover:bg-secondary/70 transition-colors"
          >
            <Download size={15} /> Export CSV
          </button>
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
        <StatCard icon={Users} label="Total referrals" value={fmtNumber(total)} gradient="gradient-purple" />
        <StatCard icon={Hourglass} label="Pending" value={fmtNumber(Number(by.pending || 0))} gradient="gradient-orange" />
        <StatCard icon={AlertTriangle} label="Needs review" value={fmtNumber(Number(by.review || 0))} gradient="gradient-blue" />
        <StatCard icon={ShieldAlert} label="Rejected / expired" value={fmtNumber(Number(by.rejected || 0) + Number(by.expired || 0))} gradient="gradient-red" />
        <StatCard icon={Coins} label="Coins paid (incl. milestones)" value={fmtNumber(data?.stats?.coinsPaid ?? 0)} gradient="gradient-green" />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-5 mb-6">
        <div className="xl:col-span-2">
          <ProgramSettings program={data?.program} />
        </div>
        <div className="bg-card border border-border rounded-2xl p-5">
          <div className="flex items-center gap-2 mb-3">
            <Trophy size={16} className="text-amber-500" />
            <h3 className="font-bold text-foreground">Top inviters</h3>
          </div>
          {(data?.topReferrers ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No rewarded referrals yet.</p>
          ) : (
            <ol className="space-y-2">
              {data!.topReferrers.map((t, i) => (
                <li key={t.uid} className="flex items-center justify-between text-sm">
                  <span className="truncate">
                    <span className="text-muted-foreground mr-2">{i + 1}.</span>
                    {t.username || t.uid}
                  </span>
                  <span className="font-semibold whitespace-nowrap">
                    {fmtNumber(t.rewarded)} · <span className="text-amber-600">{fmtNumber(t.earned)} coins</span>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegTabs tab={tab} setTab={setTab} tabs={TABS} />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search username or code…"
          className="mb-4 px-3 py-2 rounded-xl border border-border bg-background text-sm w-64 focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      <Table
        loading={isLoading}
        data={rows}
        keyFn={(r: any) => r.id}
        empty="No referrals"
        columns={[
          { key: "ref", header: "Inviter", render: (r: any) => <UserCell name={r.referrerUsername || r.referrerUid} sub={r.code || r.referrerUid} /> },
          { key: "friend", header: "Friend", render: (r: any) => <UserCell name={r.referredUsername || r.referredUid} sub={r.referredUid} /> },
          {
            key: "status",
            header: "Status",
            render: (r: any) => (
              <div>
                <Badge variant={STATUS_VARIANT[r.status] || "default"}>{r.status}</Badge>
                {r.rejectReason && <p className="text-[11px] text-muted-foreground mt-1 max-w-[220px]">{REASONS[r.rejectReason] || r.rejectReason}</p>}
              </div>
            ),
          },
          {
            key: "qualify",
            header: "Qualifies on",
            render: (r: any) => (
              <div className="text-xs">
                <p className="font-medium">{ACTION_LABEL[r.qualifyAction] || r.qualifyAction || "—"}</p>
                <p className="text-muted-foreground">
                  {r.referredEmailVerified ? "✓ email" : "✗ email"} · {r.referredPhoneVerified ? "✓ mobile" : "✗ mobile"} · {fmtNumber(r.referredContests || 0)} contests
                </p>
              </div>
            ),
          },
          {
            key: "reward",
            header: "Paid",
            render: (r: any) =>
              r.status === "rewarded" ? (
                <span className="text-xs font-semibold">
                  Inviter {fmtNumber(r.referrerReward)} · Friend {fmtNumber(r.refereeReward)}
                </span>
              ) : (
                <span className="text-muted-foreground">—</span>
              ),
          },
          { key: "device", header: "Device", render: (r: any) => <span className="font-mono text-[11px] text-muted-foreground">{r.deviceId ? String(r.deviceId).slice(0, 10) : "—"}</span> },
          {
            key: "dates",
            header: "Dates",
            render: (r: any) => (
              <div className="text-xs text-muted-foreground whitespace-nowrap">
                <p>Applied {fmtDateTime(r.createdAt)}</p>
                {r.rewardedAt ? <p>Paid {fmtDateTime(r.rewardedAt)}</p> : r.status === "pending" && r.expiresAt ? <p>Expires {fmtDateTime(r.expiresAt)}</p> : null}
              </div>
            ),
          },
          {
            key: "actions",
            header: "",
            className: "text-right",
            render: (r: any) =>
              r.status === "pending" || r.status === "review" ? (
                <div className="flex items-center justify-end gap-1.5">
                  <ActionBtn
                    tone="green"
                    title="Approve & pay both sides now"
                    onClick={async () => {
                      if (
                        await confirm({
                          title: "Approve referral?",
                          description:
                            r.status === "pending"
                              ? "The friend has NOT completed the qualifying action yet. Approving pays both sides now."
                              : "Both sides will be paid now (inviter subject to caps).",
                        })
                      )
                        decideMut.mutate({ id: r.id, action: "approve" });
                    }}
                  >
                    <Check size={14} /> Approve
                  </ActionBtn>
                  <ActionBtn
                    tone="red"
                    title="Reject — nobody is paid"
                    onClick={async () => {
                      const reason = window.prompt("Reason for rejecting (shown in the audit log):", "Suspected fake account");
                      if (reason === null) return;
                      decideMut.mutate({ id: r.id, action: "reject", reason: reason.trim() || "admin_rejected" });
                    }}
                  >
                    <X size={14} /> Reject
                  </ActionBtn>
                </div>
              ) : (
                <span className="text-xs text-muted-foreground">—</span>
              ),
          },
        ]}
      />
    </div>
  );
}

/* ---------------- program settings ---------------- */

function ProgramSettings({ program }: { program?: Partial<Program> }) {
  const qc = useQueryClient();
  const [p, setP] = useState<Program>(DEFAULTS);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (program && !dirty) setP({ ...DEFAULTS, ...program, milestones: [...(program.milestones || [])] });
  }, [program, dirty]);

  const set = (patch: Partial<Program>) => {
    setDirty(true);
    setP((cur) => ({ ...cur, ...patch }));
  };
  const error = useMemo(() => validate(p), [p]);
  const num = (v: string) => (v === "" ? 0 : Number(v));

  const saveMut = useMutation({
    mutationFn: () => api.saveAppSettings({ referralProgram: { ...p, milestones: [...p.milestones].sort((a, b) => a.count - b.count) } }),
    onSuccess: () => {
      toast.success("Referral program saved");
      setDirty(false);
      qc.invalidateQueries({ queryKey: ["referrals"] });
      qc.invalidateQueries({ queryKey: ["app-settings"] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const numInput = (key: keyof Program, text: string, help?: string) => (
    <div>
      <label className={label}>{text}</label>
      <input type="number" min={0} step={1} value={p[key] as number} onChange={(e) => set({ [key]: num(e.target.value) } as any)} className={field} />
      {help && <p className={hint}>{help}</p>}
    </div>
  );

  return (
    <div className="bg-card border border-border rounded-2xl p-5">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div>
          <h3 className="font-bold text-foreground">Program settings</h3>
          <p className="text-xs text-muted-foreground mt-0.5">Changes apply to codes applied from now on; pending referrals keep their qualifying action.</p>
        </div>
        <button
          onClick={() => (error ? toast.error(error) : saveMut.mutate())}
          disabled={saveMut.isPending || !dirty}
          className="flex items-center gap-2 gradient-purple text-white text-sm font-semibold px-4 py-2 rounded-xl shadow-lg disabled:opacity-50"
        >
          <Save size={15} /> Save
        </button>
      </div>

      <Toggle checked={p.enabled} onChange={(v) => set({ enabled: v })} title="Referral program enabled" description="Off: no new codes can be applied. Pending referrals still pay when they qualify." />

      <div className="grid grid-cols-2 gap-3 mt-2">
        {numInput("referrerReward", "Inviter reward (coins)", "Paid to the person who shared the code.")}
        {numInput("refereeReward", "Friend reward (coins)", "Paid to the new user who joined with the code.")}
      </div>

      <div className="mt-4">
        <label className={label}>Reward is paid when the friend…</label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {ACTIONS.map((a) => (
            <button
              key={a.k}
              type="button"
              onClick={() => set({ qualifyAction: a.k })}
              className={`text-left rounded-xl border px-3 py-2.5 transition-colors ${
                p.qualifyAction === a.k ? "border-primary bg-primary/5" : "border-border hover:bg-secondary/50"
              }`}
            >
              <p className="text-sm font-semibold text-foreground">{a.l}</p>
              <p className="text-[11px] text-muted-foreground">{a.d}</p>
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 mt-4">
        {numInput("applyWindowDays", "Code apply window (days)", "How long after joining a code can still be entered.")}
        {numInput("qualifyWindowDays", "Qualify window (days)", "Unqualified referrals expire after this.")}
        {numInput("maxRewardedPerReferrer", "Lifetime cap per inviter", "0 = unlimited. Beyond it the friend is still paid.")}
        {numInput("maxRewardedPerReferrerPerDay", "Daily cap per inviter", "0 = unlimited. Stops referral farming bursts.")}
      </div>

      <Toggle
        checked={p.requireReview}
        onChange={(v) => set({ requireReview: v })}
        title="Hold qualified referrals for admin review"
        description="On: nothing is paid until you approve it below. Use during a fraud wave."
      />

      <div className="mt-4">
        <div className="flex items-center justify-between mb-2">
          <label className={label + " mb-0"}>Milestone bonuses (for the inviter)</label>
          <button
            type="button"
            onClick={() => {
              const last = p.milestones[p.milestones.length - 1];
              set({ milestones: [...p.milestones, { count: last ? last.count + 5 : 5, bonus: last ? last.bonus * 2 : 100 }] });
            }}
            className="flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
          >
            <Plus size={13} /> Add tier
          </button>
        </div>
        {p.milestones.length === 0 ? (
          <p className="text-xs text-muted-foreground">No milestones. Example: 5 friends → 100 extra coins, 10 friends → 300.</p>
        ) : (
          <div className="space-y-2">
            {p.milestones.map((m, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  value={m.count}
                  onChange={(e) => set({ milestones: p.milestones.map((x, j) => (j === i ? { ...x, count: num(e.target.value) } : x)) })}
                  className={field + " w-28"}
                />
                <span className="text-xs text-muted-foreground whitespace-nowrap">successful referrals →</span>
                <input
                  type="number"
                  min={1}
                  value={m.bonus}
                  onChange={(e) => set({ milestones: p.milestones.map((x, j) => (j === i ? { ...x, bonus: num(e.target.value) } : x)) })}
                  className={field + " w-28"}
                />
                <span className="text-xs text-muted-foreground">coins</span>
                <button
                  type="button"
                  title="Remove tier"
                  onClick={() => set({ milestones: p.milestones.filter((_, j) => j !== i) })}
                  className="ml-auto text-muted-foreground hover:text-red-600"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-4 rounded-xl bg-secondary/60 p-3 text-xs text-muted-foreground">
        <p className="font-semibold text-foreground mb-1">Users see</p>
        “Dost ko invite karo — jab woh {ACTION_LABEL[p.qualifyAction]?.toLowerCase()} karega, aapko {p.referrerReward} coins aur aapke dost ko {p.refereeReward} coins
        milenge.” Fraud checks always on: no self-referral, no referrer's device, one referral per device.
      </div>

      {error && (
        <p className="text-xs text-red-600 mt-2 flex items-center gap-1.5">
          <AlertTriangle size={13} /> {error}
        </p>
      )}
    </div>
  );
}
