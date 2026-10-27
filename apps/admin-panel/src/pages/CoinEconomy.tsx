import { useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Coins,
  Download,
  Gift,
  KeyRound,
  Lock,
  Plus,
  Scale,
  Search,
  Wallet,
} from "lucide-react";
import {
  api,
  describeError,
  type CoinEconomy as CoinEconomyData,
  type PromoBudget,
  type PromoBudgetKind,
  type PromoBudgetStatus,
} from "@/lib/api";
import { Table } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { StatCard } from "@/components/ui/StatCard";
import { SegTabs } from "@/components/finance/bits";
import { PageHeader, exportCsv, fmtDateTime, fmtNumber } from "@/lib/format";
import { toast } from "@/lib/toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { CoinPricingCard, RewardLockingCard, WithdrawalCard } from "@/components/coin/CoinCards";
import { CoinAlertsCard, FreeRewardsBudgetCard } from "@/components/coin/AlertCards";
import { AdsRewardCard, DailyLoginCard, DailyTasksCard, HallOfFameCard, VerificationRewardCard } from "@/components/coin/EarnCards";
import { ProgramSettings } from "@/pages/Referrals";
import { GatewayConfig } from "@/pages/Deposits";
import CoinPackages from "@/pages/CoinPackages";
import Transactions from "@/pages/Transactions";

/**
 * Coin Economy — the one place for everything coins: where every coin came from,
 * where it went, and every setting that creates, sells or pays out coins.
 *
 *   Overview   supply (withdrawable vs locked), ₹ liability, flows by source, the
 *              platform's own side, reconciliation checks, pending queues
 *   Earn       every free-coin source (verification, referral, daily login,
 *              daily tasks, rewarded ads, Hall of Fame) + the play-only switch
 *   Buy        buy rate, payment gateway, coin packages and their P&L
 *   Contests   per-contest P&L: entry fees, prizes, refunds, subsidy, fees kept
 *   Cash out   withdrawal rules, fee, emergency freeze
 *   Budgets    one promo budget per offer, approval password
 *   Ledger     every coin transaction, and one user's full statement
 *   Health     money-integrity checks
 *
 * Each settings card saves only its own keys, through the same Worker routes
 * (validation, audit log) the old pages used; those pages now link here.
 *
 * Worker: lib/coinEconomy.ts, lib/promoBudget.ts, lib/approvalPassword.ts.
 */
const TABS = [
  { key: "overview", label: "Overview" },
  { key: "earn", label: "Earn" },
  { key: "buy", label: "Buy" },
  { key: "contests", label: "Contests" },
  { key: "cashout", label: "Cash out" },
  { key: "budgets", label: "Budgets" },
  { key: "ledger", label: "Ledger" },
  { key: "health", label: "Health" },
];

const KIND_LABEL: Record<PromoBudgetKind, string> = {
  package_bonus: "Package bonus",
  contest_prize: "Contest prize (coins)",
  product_prize: "Product prize (coin value)",
  free_rewards: "Free rewards (daily, ads, tasks)",
};

const PLATFORM_LABEL: Record<string, string> = {
  promo_bonus: "Package bonus diya (budget se)",
  prize_subsidy: "Contest prize subsidy (budget se)",
  product_prize: "Product prize ki coin value (budget se)",
  product_prize_reversal: "Cancel hue prize claim — budget me wapas",
  platform_fee: "Entry fee platform ne rakhi",
  product_prize_fund: "Product prize ke liye entry fee rakhi",
  free_reward: "Free rewards diye (budget se)",
};

const inr = (n: number) => `₹${fmtNumber(Math.round((n || 0) * 100) / 100)}`;
const signed = (n: number) => `${n > 0 ? "+" : ""}${fmtNumber(n)}`;
const field =
  "w-full px-3 py-2.5 rounded-xl border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring";

export default function CoinEconomy() {
  const [tab, setTab] = useState("overview");
  return (
    <div>
      <PageHeader
        title="Coin Economy"
        subtitle="Har coin ka hisab: kahan se aaya, kahan gaya, aur platform ne apni taraf se kitna diya."
      />
      <div className="overflow-x-auto">
        <SegTabs tab={tab} setTab={setTab} tabs={TABS} />
      </div>
      {tab === "overview" && (
        <div className="space-y-6">
          <PendingQueues />
          <Overview />
        </div>
      )}
      {tab === "earn" && <EarnTab />}
      {tab === "buy" && <BuyTab />}
      {tab === "contests" && <ContestsPnl />}
      {tab === "cashout" && <CashOutTab />}
      {tab === "budgets" && <Budgets />}
      {tab === "ledger" && (
        <div className="space-y-8">
          <Transactions />
          <div>
            <p className="font-bold text-foreground mb-3">User statement</p>
            <UserStatementView />
          </div>
        </div>
      )}
      {tab === "health" && <HealthTab />}
    </div>
  );
}

// ─── Shared settings plumbing ────────────────────────────────────────────────

/** appConfig for the settings cards, plus the same per-card save App Control used. */
function useAppConfig() {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ["app-settings"], queryFn: api.appSettings });
  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.saveAppSettings(patch),
    onSuccess: () => {
      toast.success("Saved — users ke app me turant live");
      qc.invalidateQueries({ queryKey: ["app-settings"] });
      qc.invalidateQueries({ queryKey: ["coin-packages"] });
    },
    onError: (e) => toast.error(describeError(e)),
  });
  return { data: query.data, isLoading: query.isLoading, save };
}

function PendingQueues() {
  const { data } = useQuery({ queryKey: ["overview"], queryFn: api.overview });
  const items = [
    { label: "Deposits approve karne hain", n: Number((data as any)?.pendingDeposits ?? 0), href: "/deposits" },
    { label: "Withdrawals pending", n: Number((data as any)?.pendingWithdrawals ?? 0), href: "/withdrawals" },
    { label: "Prize claims pending", n: Number((data as any)?.pendingPrizeClaims ?? 0), href: "/prize-claims" },
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {items.map((i) => (
        <Link key={i.href} href={i.href}>
          <div className={`rounded-2xl border p-4 cursor-pointer hover:shadow-sm ${i.n > 0 ? "border-amber-300 bg-amber-50" : "border-border bg-card"}`}>
            <p className="text-2xl font-bold text-foreground">{fmtNumber(i.n)}</p>
            <p className="text-sm text-muted-foreground">{i.label} →</p>
          </div>
        </Link>
      ))}
    </div>
  );
}

// ─── Earn ────────────────────────────────────────────────────────────────────

const EARN_TYPES: { type: string; label: string }[] = [
  { type: "signup_bonus", label: "Signup bonus (turant)" },
  { type: "verification_bonus", label: "Signup bonus (email + mobile verify)" },
  { type: "referral_bonus", label: "Referral" },
  { type: "daily_reward", label: "Daily login" },
  { type: "daily_task", label: "Daily tasks" },
  { type: "ad_reward", label: "Rewarded ads" },
  { type: "monthly_hall_of_fame_reward", label: "Hall of Fame" },
  { type: "promo_bonus", label: "Package promo bonus" },
  { type: "admin_adjustment", label: "Admin adjustment" },
];

function EarnTab() {
  const { data, isLoading, save } = useAppConfig();
  const rewards = useQuery({ queryKey: ["rewards"], queryFn: api.rewards });
  const referrals = useQuery({ queryKey: ["referrals", "", ""], queryFn: () => api.referrals({}) });
  const since = useState(() => Date.now() - 30 * 24 * 60 * 60 * 1000)[0];
  const month = useQuery({ queryKey: ["coin-economy", "30d"], queryFn: () => api.coinEconomy({ from: since }) });
  if (isLoading || !data) return <p className="text-sm text-muted-foreground py-10 text-center">Loading…</p>;
  const byType = new Map((month.data?.types ?? []).map((t) => [t.type, t]));
  return (
    <div className="space-y-6">
      <Card title="Free coin: pichhle 30 din me kitna diya">
        <Table
          data={EARN_TYPES}
          keyFn={(t) => t.type}
          columns={[
            { key: "s", header: "Source", render: (t) => <span className="font-medium text-foreground">{t.label}</span> },
            { key: "c", header: "Coins diye", className: "text-right", render: (t) => fmtNumber(byType.get(t.type)?.credits ?? 0) },
            { key: "l", header: "Locked", className: "text-right", render: (t) => fmtNumber(Math.max(0, byType.get(t.type)?.locked ?? 0)) },
            { key: "n", header: "Entries", className: "text-right", render: (t) => fmtNumber(byType.get(t.type)?.count ?? 0) },
            { key: "r", header: "≈ ₹", className: "text-right", render: (t) => inr((byType.get(t.type)?.credits ?? 0) * (month.data?.payoutRate ?? 0)) },
          ]}
        />
      </Card>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <RewardLockingCard data={data} pending={save.isPending} onSave={(p) => save.mutate(p)} />
        <FreeRewardsBudgetCard data={data} pending={save.isPending} onSave={(p) => save.mutate(p)} />
        <CoinAlertsCard data={data} pending={save.isPending} onSave={(p) => save.mutate(p)} />
        <VerificationRewardCard data={data} />
        <DailyLoginCard rewards={rewards.data} />
        <DailyTasksCard rewards={rewards.data} />
        <AdsRewardCard data={data} />
        <HallOfFameCard rewards={rewards.data} />
      </div>
      <div>
        <ProgramSettings program={referrals.data?.program} />
        <p className="mt-2 text-xs text-muted-foreground">
          Referral ki queue aur approvals: <Link href="/referrals" className="underline">Referral Program</Link>.
        </p>
      </div>
    </div>
  );
}

// ─── Buy ─────────────────────────────────────────────────────────────────────

function BuyTab() {
  const { data, isLoading, save } = useAppConfig();
  if (isLoading || !data) return <p className="text-sm text-muted-foreground py-10 text-center">Loading…</p>;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
        <CoinPricingCard data={data} pending={save.isPending} onSave={(p) => save.mutate(p)} />
        <GatewayConfig />
      </div>
      <CoinPackages />
      <div>
        <p className="font-bold text-foreground mb-3">Package P&amp;L</p>
        <PackagesPnl />
      </div>
    </div>
  );
}

// ─── Cash out ────────────────────────────────────────────────────────────────

function CashOutTab() {
  const { data, isLoading, save } = useAppConfig();
  const { confirm } = useConfirm();
  const eco = useQuery({ queryKey: ["coin-economy"], queryFn: () => api.coinEconomy() });
  if (isLoading || !data) return <p className="text-sm text-muted-foreground py-10 text-center">Loading…</p>;
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
      <WithdrawalCard data={data} pending={save.isPending} onSave={(p) => save.mutate(p)} confirm={confirm} />
      <Card title="Payout ka hisab">
        {eco.data ? (
          <>
            <Row label="Withdraw ho sakne wale coin" value={fmtNumber(eco.data.supply.withdrawable)} />
            <Row label="Liability (agar sab nikal lein)" value={inr(eco.data.supply.liabilityInr)} />
            <Row label="Payout bheja" value={inr(eco.data.cash.paidOutInr)} />
            <Row label="Payout baaki (pending/approved)" value={inr(eco.data.cash.pendingOutInr)} strong />
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
        <p className="mt-3 text-sm">
          <Link href="/withdrawals" className="font-semibold text-primary">Withdrawal requests approve / pay karo →</Link>
        </p>
      </Card>
    </div>
  );
}

// ─── Health ──────────────────────────────────────────────────────────────────

function HealthTab() {
  const money = useQuery({ queryKey: ["money-health"], queryFn: api.moneyHealth });
  const eco = useQuery({ queryKey: ["coin-economy"], queryFn: () => api.coinEconomy() });
  const m = money.data;
  const rows: { label: string; n: number | undefined }[] = m
    ? [
        { label: "Ledger drift (balance ≠ ledger)", n: m.ledgerDrift.count },
        { label: "Negative balances", n: m.negativeBalances.count },
        { label: "Paid but not credited orders", n: m.strandedPaidOrders },
        { label: "Approved deposits not credited", n: m.strandedApprovedDeposits },
        { label: "Clawback shortfalls", n: m.clawbackShortfalls.count },
        { label: "Withdrawal ledger gaps", n: m.withdrawalLedgerGaps?.count },
        { label: "Locked coin drift", n: (m.lockedDrift?.count ?? 0) + (m.lockedDrift?.overBalance ?? 0) },
        { label: "Stuck promo reservations", n: m.staleReservations },
      ]
    : [];
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
      <Card title="Money integrity">
        {money.error ? <ErrorBox error={money.error} /> : null}
        {rows.map((r) => (
          <Row
            key={r.label}
            label={r.label}
            value={<span className={(r.n ?? 0) === 0 ? "text-green-600" : "text-red-600 font-semibold"}>{(r.n ?? 0) === 0 ? "OK" : fmtNumber(r.n ?? 0)}</span>}
          />
        ))}
        <p className="mt-3 text-xs text-muted-foreground">
          Poori detail: <Link href="/system-health" className="underline">System Health</Link>. Ye check har 6 ghante bhi chalta hai aur fail hone par
          notification aata hai.
        </p>
      </Card>
      <Card title="Reconciliation checks">
        <ul className="space-y-2">
          {(eco.data?.checks ?? []).map((c) => (
            <li key={c.key} className="flex items-start gap-2 text-sm">
              {c.ok ? <CheckCircle2 size={16} className="mt-0.5 text-green-600 shrink-0" /> : <AlertTriangle size={16} className="mt-0.5 text-red-600 shrink-0" />}
              <span>
                <span className="font-medium text-foreground">{c.label}</span>
                <span className="block text-xs text-muted-foreground">{c.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

// ─── Overview ────────────────────────────────────────────────────────────────

const RANGES = [
  { key: "all", label: "Shuru se" },
  { key: "today", label: "Aaj" },
  { key: "7d", label: "7 din" },
  { key: "30d", label: "30 din" },
  { key: "custom", label: "Custom" },
];

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/**
 * Coin flows (by source) and the platform side follow the range (worker
 * coinEconomyOverview filters coin_transactions / platform_ledger); supply,
 * cash and checks are always all-time.
 */
function Overview() {
  const [range, setRange] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const bounds = (() => {
    const now = Date.now();
    if (range === "today") return { from: startOfToday() };
    if (range === "7d") return { from: now - 7 * 24 * 60 * 60 * 1000 };
    if (range === "30d") return { from: now - 30 * 24 * 60 * 60 * 1000 };
    if (range === "custom") {
      // Whole days: from 00:00 of the first day to 23:59:59 of the last.
      const f = from ? new Date(`${from}T00:00:00`).getTime() : undefined;
      const t = to ? new Date(`${to}T23:59:59.999`).getTime() : undefined;
      return { from: f, to: t };
    }
    return {};
  })();
  // Round "now"-relative bounds to the minute so the query key stays stable.
  const key = [bounds.from ? Math.floor(bounds.from / 60_000) : 0, bounds.to ? Math.floor(bounds.to / 60_000) : 0];
  const { data, isLoading, error } = useQuery({
    queryKey: range === "all" ? ["coin-economy"] : ["coin-economy", range, ...key],
    queryFn: () => api.coinEconomy(bounds),
  });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {RANGES.map((r) => (
          <button
            key={r.key}
            onClick={() => setRange(r.key)}
            className={`px-3 py-1.5 rounded-xl text-xs font-semibold ${range === r.key ? "gradient-purple text-white" : "bg-secondary text-foreground"}`}
          >
            {r.label}
          </button>
        ))}
        {range === "custom" && (
          <span className="flex items-center gap-2 text-xs">
            <input type="date" className="px-2 py-1.5 rounded-lg border border-border bg-background" value={from} onChange={(e) => setFrom(e.target.value)} />
            se
            <input type="date" className="px-2 py-1.5 rounded-lg border border-border bg-background" value={to} onChange={(e) => setTo(e.target.value)} />
            tak
          </span>
        )}
      </div>
      {range !== "all" && (
        <p className="text-xs text-muted-foreground">
          "Coin kahan se aaye" aur "Platform ka hisab" is time ke hain. Balance, liability, paisa (₹) aur checks hamesha shuru se abhi tak ke hain.
        </p>
      )}
      {isLoading ? (
        <p className="text-sm text-muted-foreground py-10 text-center">Loading…</p>
      ) : error || !data ? (
        <ErrorBox error={error} />
      ) : (
        <OverviewBody data={data} />
      )}
    </div>
  );
}

function OverviewBody({ data }: { data: CoinEconomyData }) {
  const categories = Object.entries(data.categories).sort((a, b) => Math.abs(b[1].net) - Math.abs(a[1].net));
  const platformRows = Object.entries(data.platform.kinds);
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard icon={Coins} label="Users ke paas total coin" value={fmtNumber(data.supply.total)} gradient="gradient-purple" />
        <StatCard icon={Wallet} label="Withdraw ho sakte hain" value={fmtNumber(data.supply.withdrawable)} gradient="gradient-green" />
        <StatCard icon={Lock} label="Locked (promo, sirf khelne ke liye)" value={fmtNumber(data.supply.locked)} gradient="gradient-orange" />
        <StatCard icon={Scale} label={`Liability (₹${fmtNumber(data.payoutRate)}/coin)`} value={inr(data.supply.liabilityInr)} gradient="gradient-red" />
      </div>
      {data.house && data.house.total ? (
        <p className="text-xs text-muted-foreground">
          Superadmin ke {fmtNumber(data.house.total)} coin (platform ke apne) is hisab me nahi gine gaye. Unka withdrawal nahi hota.
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Paisa (₹)">
          <Row label="Users ne diya (payments)" value={inr(data.cash.paidInInr)} />
          <Row label="Refund kiya" value={inr(data.cash.refundedInr)} />
          <Row label="Payout bheja (withdrawals paid)" value={inr(data.cash.paidOutInr)} />
          <Row label="Payout baaki (pending/approved)" value={inr(data.cash.pendingOutInr)} />
          <Row
            label="Net (aaya − refund − bheja − baaki − liability)"
            value={inr(data.cash.paidInInr - data.cash.refundedInr - data.cash.paidOutInr - data.cash.pendingOutInr - data.supply.liabilityInr)}
            strong
          />
        </Card>
        <Card title="Platform ka hisab (coins)">
          {platformRows.length === 0 ? (
            <p className="text-sm text-muted-foreground">Abhi koi entry nahi.</p>
          ) : (
            platformRows.map(([kind, v]) => (
              <Row
                key={kind}
                label={`${PLATFORM_LABEL[kind] ?? kind} (${fmtNumber(v.count)})`}
                value={<span className={v.coins < 0 ? "text-red-600" : "text-green-600"}>{signed(v.coins)}</span>}
              />
            ))
          )}
          <Row label="Net (rakha − diya)" value={<span className={data.platform.net < 0 ? "text-red-600" : "text-green-600"}>{signed(data.platform.net)}</span>} strong />
          <p className="mt-2 text-xs text-muted-foreground">
            Budgets: {fmtNumber(data.budgets.spent)} / {fmtNumber(data.budgets.total)} coin kharch · {data.budgets.active} active
          </p>
        </Card>
      </div>

      <Card title="Reconciliation checks">
        <ul className="space-y-2">
          {data.checks.map((c) => (
            <li key={c.key} className="flex items-start gap-2 text-sm">
              {c.ok ? <CheckCircle2 size={16} className="mt-0.5 text-green-600 shrink-0" /> : <AlertTriangle size={16} className="mt-0.5 text-red-600 shrink-0" />}
              <span>
                <span className="font-medium text-foreground">{c.label}</span>
                <span className="block text-xs text-muted-foreground">{c.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Coin kahan se aaye, kahan gaye (by source)">
        <Table
          data={categories}
          keyFn={([k]) => k}
          columns={[
            { key: "label", header: "Source", render: ([, c]) => <span className="font-medium text-foreground">{c.label}</span> },
            { key: "in", header: "Users ko mile", className: "text-right", render: ([, c]) => <span className="text-green-600">{fmtNumber(c.credits)}</span> },
            { key: "out", header: "Users se gaye", className: "text-right", render: ([, c]) => <span className="text-red-600">{fmtNumber(c.debits)}</span> },
            { key: "net", header: "Net", className: "text-right", render: ([, c]) => <span className="font-semibold">{signed(c.net)}</span> },
            { key: "locked", header: "Locked (net)", className: "text-right", render: ([, c]) => (c.locked ? <span className="text-amber-600">{signed(c.locked)}</span> : <span className="text-muted-foreground">—</span>) },
          ]}
        />
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-muted-foreground">Har ledger type alag se dekho ({data.types.length})</summary>
          <Table
            data={data.types}
            keyFn={(t) => t.type}
            columns={[
              { key: "type", header: "Type", render: (t) => <span className="font-mono text-xs">{t.type}</span> },
              { key: "count", header: "Rows", className: "text-right", render: (t) => fmtNumber(t.count) },
              { key: "in", header: "+", className: "text-right", render: (t) => fmtNumber(t.credits) },
              { key: "out", header: "−", className: "text-right", render: (t) => fmtNumber(t.debits) },
              { key: "net", header: "Net", className: "text-right", render: (t) => signed(t.net) },
              { key: "locked", header: "Locked", className: "text-right", render: (t) => (t.locked ? signed(t.locked) : "—") },
            ]}
          />
        </details>
      </Card>
    </div>
  );
}

// ─── Budgets ─────────────────────────────────────────────────────────────────

function Budgets() {
  const qc = useQueryClient();
  const { data: budgets = [], isLoading, error } = useQuery({ queryKey: ["promo-budgets"], queryFn: api.promoBudgets });
  const { data: approval } = useQuery({ queryKey: ["approval-password"], queryFn: api.approvalPasswordStatus });
  const [dialog, setDialog] = useState<PromoBudget | "new" | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["promo-budgets"] });
    qc.invalidateQueries({ queryKey: ["coin-economy"] });
  };

  return (
    <div className="space-y-4">
      <ApprovalPasswordCard configured={!!approval?.configured} updatedAt={approval?.updatedAt ?? null} />
      <div className="flex justify-end">
        <button
          onClick={() => setDialog("new")}
          disabled={!approval?.configured}
          title={approval?.configured ? undefined : "Pehle approval password set karo"}
          className="flex items-center gap-2 gradient-purple text-white text-sm font-semibold px-4 py-2 rounded-xl disabled:opacity-50"
        >
          <Plus size={16} /> New budget
        </button>
      </div>
      {error ? <ErrorBox error={error} /> : null}
      <Table
        loading={isLoading}
        data={budgets}
        keyFn={(b) => b.id}
        empty="Abhi koi budget nahi. Har offer ke liye ek budget banao."
        columns={[
          {
            key: "name",
            header: "Budget",
            render: (b) => (
              <button className="text-left" onClick={() => setDetail(b.id)}>
                <span className="font-medium text-foreground underline-offset-2 hover:underline">{b.name}</span>
                <span className="block text-xs text-muted-foreground">{KIND_LABEL[b.kind]}</span>
              </button>
            ),
          },
          {
            key: "use",
            header: "Kharch",
            render: (b) => <BudgetBar b={b} />,
          },
          {
            key: "window",
            header: "Time",
            render: (b) => (
              <span className="text-xs text-muted-foreground">
                {b.startsAt ? fmtDateTime(b.startsAt) : "abhi se"} → {b.endsAt ? fmtDateTime(b.endsAt) : "koi end nahi"}
                {b.perUserLimit ? <span className="block">Per user max {fmtNumber(b.perUserLimit)}</span> : null}
              </span>
            ),
          },
          {
            key: "links",
            header: "Linked",
            render: (b) => (
              <span className="text-xs text-muted-foreground">
                {b.kind === "package_bonus" ? `${b.linkedPackages} package` : b.kind === "free_rewards" ? "daily, ads, tasks" : `${b.linkedContests} contest`} · {b.usedCount} use
                {b.status === "active" && b.remainingCoins <= 0 ? <span className="block text-red-600">Khatam — Edit karke total badhao</span> : null}
              </span>
            ),
          },
          {
            key: "status",
            header: "Status",
            render: (b) => (
              <Badge variant={b.status === "closed" ? "ended" : b.live ? "active" : "warning"}>
                {b.status === "active" && !b.live ? "active (band)" : b.status}
              </Badge>
            ),
          },
          {
            key: "actions",
            header: "",
            className: "text-right",
            render: (b) =>
              b.status === "closed" ? null : (
                <button onClick={() => setDialog(b)} className="text-sm text-primary font-medium">Edit</button>
              ),
          },
        ]}
      />
      {dialog && <BudgetDialog budget={dialog === "new" ? undefined : dialog} onClose={() => setDialog(null)} onDone={refresh} />}
      {detail && <BudgetDetail id={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

function BudgetBar({ b }: { b: PromoBudget }) {
  const pct = (n: number) => (b.totalCoins > 0 ? Math.min(100, (n / b.totalCoins) * 100) : 0);
  return (
    <div className="min-w-[180px]">
      <div className="h-2 w-full rounded-full bg-secondary overflow-hidden flex">
        <div className="h-full bg-purple-600" style={{ width: `${pct(b.spentCoins)}%` }} />
        <div className="h-full bg-amber-400" style={{ width: `${pct(b.heldCoins)}%` }} />
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {fmtNumber(b.spentCoins)} kharch · {fmtNumber(b.heldCoins)} reserved · <b className="text-foreground">{fmtNumber(b.remainingCoins)}</b> bache / {fmtNumber(b.totalCoins)}
      </p>
    </div>
  );
}

const toLocal = (ms: number | null) => {
  if (!ms) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fromLocal = (v: string) => (v ? new Date(v).getTime() : null);

function BudgetDialog({ budget, onClose, onDone }: { budget?: PromoBudget; onClose: () => void; onDone: () => void }) {
  const isEdit = !!budget;
  const [form, setForm] = useState({
    name: budget?.name ?? "",
    kind: (budget?.kind ?? "package_bonus") as PromoBudgetKind,
    totalCoins: String(budget?.totalCoins ?? ""),
    startsAt: toLocal(budget?.startsAt ?? null),
    endsAt: toLocal(budget?.endsAt ?? null),
    perUserLimit: budget?.perUserLimit ? String(budget.perUserLimit) : "",
    note: budget?.note ?? "",
    status: (budget?.status ?? "active") as PromoBudgetStatus,
    reason: "",
  });
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const mut = useMutation({
    mutationFn: async () => {
      const common = {
        name: form.name.trim(),
        totalCoins: Number(form.totalCoins),
        startsAt: fromLocal(form.startsAt),
        endsAt: fromLocal(form.endsAt),
        perUserLimit: (form.kind === "package_bonus" || form.kind === "free_rewards") && form.perUserLimit ? Number(form.perUserLimit) : null,
        note: form.note.trim() || null,
        reason: form.reason.trim(),
      };
      if (isEdit) return api.updatePromoBudget(budget!.id, { ...common, status: form.status });
      return api.createPromoBudget({ ...common, kind: form.kind });
    },
    onSuccess: () => {
      toast.success(isEdit ? "Budget updated" : "Budget ban gaya");
      onDone();
      onClose();
    },
    onError: (e) => toast.error(describeError(e)),
  });
  const committed = budget ? budget.spentCoins + budget.heldCoins : 0;

  return (
    <Overlay onClose={onClose}>
      <h3 className="font-bold text-foreground mb-4">{isEdit ? `Edit budget: ${budget!.name}` : "New promo budget"}</h3>
      <div className="space-y-3">
        <input className={field} placeholder="Naam, e.g. Diwali bonus" value={form.name} onChange={(e) => set("name", e.target.value)} />
        {!isEdit && (
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Kis ke liye</label>
            <select className={field} value={form.kind} onChange={(e) => set("kind", e.target.value)}>
              <option value="package_bonus">Coin package ka bonus (locked, sirf khelne ke liye)</option>
              <option value="contest_prize">Contest coin prize jo pot se zyada ho</option>
              <option value="product_prize">Product prize ki coin value (sirf admin ko dikhegi)</option>
              <option value="free_rewards">Free rewards ki limit (daily login, ads, tasks)</option>
            </select>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Total coins (limit)</label>
            <input type="number" className={field} value={form.totalCoins} onChange={(e) => set("totalCoins", e.target.value)} />
            {isEdit && committed > 0 ? <p className="mt-1 text-xs text-muted-foreground">Kam se kam {fmtNumber(committed)}</p> : null}
          </div>
          {form.kind === "package_bonus" || form.kind === "free_rewards" ? (
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Per user max coins</label>
              <input type="number" className={field} placeholder="Koi limit nahi" value={form.perUserLimit} onChange={(e) => set("perUserLimit", e.target.value)} />
            </div>
          ) : <div />}
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Shuru</label>
            <input type="datetime-local" className={field} value={form.startsAt} onChange={(e) => set("startsAt", e.target.value)} />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Khatam</label>
            <input type="datetime-local" className={field} value={form.endsAt} onChange={(e) => set("endsAt", e.target.value)} />
          </div>
        </div>
        {isEdit && (
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Status</label>
            <select className={field} value={form.status} onChange={(e) => set("status", e.target.value)}>
              <option value="active">Active</option>
              <option value="paused">Paused (offer rukega, reserved coins safe)</option>
              <option value="closed">Closed (hamesha ke liye band)</option>
            </select>
          </div>
        )}
        <textarea className={field} rows={2} placeholder="Note (optional)" value={form.note} onChange={(e) => set("note", e.target.value)} />
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Reason (audit log me jayega) *</label>
          <input className={field} placeholder="Kyun ye budget / badlav?" value={form.reason} onChange={(e) => set("reason", e.target.value)} />
        </div>
        <p className="text-xs text-muted-foreground">Save karne par approval password maanga jayega.</p>
      </div>
      <div className="flex gap-2 mt-5">
        <button onClick={onClose} className="flex-1 py-2.5 rounded-xl bg-secondary text-sm font-medium">Cancel</button>
        <button
          onClick={() => mut.mutate()}
          disabled={mut.isPending || !form.name.trim() || !form.totalCoins || form.reason.trim().length < 3}
          className="flex-1 py-2.5 rounded-xl gradient-purple text-white text-sm font-semibold disabled:opacity-50"
        >
          {isEdit ? "Save" : "Create"}
        </button>
      </div>
    </Overlay>
  );
}

function BudgetDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, isLoading, error } = useQuery({ queryKey: ["promo-budget", id], queryFn: () => api.promoBudget(id) });
  return (
    <Overlay onClose={onClose} wide>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : error || !data ? (
        <ErrorBox error={error} />
      ) : (
        <div className="space-y-4">
          <div>
            <h3 className="font-bold text-foreground">{data.budget.name}</h3>
            <p className="text-xs text-muted-foreground">{KIND_LABEL[data.budget.kind]} · banaya {fmtDateTime(data.budget.createdAt)} · {data.budget.createdBy ?? "—"}</p>
            <div className="mt-2"><BudgetBar b={data.budget} /></div>
            {data.budget.note ? <p className="mt-2 text-sm text-muted-foreground">{data.budget.note}</p> : null}
          </div>
          <div>
            <p className="text-sm font-semibold mb-1">Linked</p>
            {data.packages.map((p) => (
              <p key={p.id} className="text-sm">Package: {p.name ?? p.id} · {fmtNumber(p.coins)} + {fmtNumber(p.bonusCoins)} bonus {p.active ? "" : "(hidden)"}</p>
            ))}
            {data.contests.map((c) => (
              <p key={c.id} className="text-sm">Contest: {c.title ?? c.id} · fee {fmtNumber(c.totalEntryFee)} · prize {fmtNumber(c.rewardCoins)} ({c.status})</p>
            ))}
            {!data.packages.length && !data.contests.length ? <p className="text-sm text-muted-foreground">Kuch linked nahi.</p> : null}
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <p className="text-sm font-semibold">Payouts ({data.payouts.length})</p>
              <button
                className="text-xs text-primary flex items-center gap-1"
                onClick={() => exportCsv(`budget-${data.budget.id}.csv`, data.payouts, ["createdAt", "kind", "coins", "uid", "contestId", "matchId", "refId", "description"])}
              >
                <Download size={12} /> CSV
              </button>
            </div>
            <Table
              data={data.payouts}
              keyFn={(p) => p.id}
              empty="Abhi kuch nahi diya gaya"
              columns={[
                { key: "t", header: "Kab", render: (p) => <span className="text-xs">{fmtDateTime(p.createdAt)}</span> },
                { key: "u", header: "User", render: (p) => <span className="font-mono text-xs">{p.uid ?? "—"}</span> },
                { key: "c", header: "Coins", className: "text-right", render: (p) => <span className="text-red-600">{fmtNumber(-p.coins)}</span> },
                { key: "d", header: "Detail", render: (p) => <span className="text-xs text-muted-foreground">{p.description}</span> },
              ]}
            />
          </div>
          <div>
            <p className="text-sm font-semibold mb-1">Reservations ({data.reservations.length})</p>
            <Table
              data={data.reservations}
              keyFn={(r) => r.id}
              empty="Koi reservation nahi"
              columns={[
                { key: "t", header: "Kab", render: (r) => <span className="text-xs">{fmtDateTime(r.createdAt)}</span> },
                { key: "ref", header: "Kis ke liye", render: (r) => <span className="font-mono text-xs">{r.refType}:{r.refId.slice(0, 12)}</span> },
                { key: "c", header: "Coins", className: "text-right", render: (r) => fmtNumber(r.coins) },
                {
                  key: "s",
                  header: "Status",
                  render: (r) => {
                    const expired = r.status === "held" && r.expiresAt != null && r.expiresAt <= Date.now();
                    return <Badge variant={r.status === "used" ? "success" : r.status === "released" || expired ? "ended" : "pending"}>{expired ? "expired" : r.status}</Badge>;
                  },
                },
              ]}
            />
          </div>
        </div>
      )}
      <div className="flex justify-end mt-4">
        <button onClick={onClose} className="px-4 py-2 rounded-xl bg-secondary text-sm font-medium">Close</button>
      </div>
    </Overlay>
  );
}

function ApprovalPasswordCard({ configured, updatedAt }: { configured: boolean; updatedAt: number | null }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirmNext, setConfirmNext] = useState("");
  const [resetOpen, setResetOpen] = useState(false);
  const mut = useMutation({
    mutationFn: () => api.setApprovalPassword({ current: configured ? current : undefined, next }),
    onSuccess: () => {
      toast.success(configured ? "Approval password badal gaya" : "Approval password set ho gaya");
      setOpen(false);
      setCurrent(""); setNext(""); setConfirmNext("");
      qc.invalidateQueries({ queryKey: ["approval-password"] });
      qc.invalidateQueries({ queryKey: ["coin-economy"] });
    },
    onError: (e) => toast.error(describeError(e)),
  });
  const mismatch = confirmNext.length > 0 && next !== confirmNext;
  return (
    <div className={`rounded-2xl border p-4 ${configured ? "border-border bg-card" : "border-amber-300 bg-amber-50"}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex gap-3">
          <KeyRound size={20} className={configured ? "text-purple-600" : "text-amber-700"} />
          <div>
            <p className="font-semibold text-foreground">Approval password</p>
            <p className="text-sm text-muted-foreground">
              {configured
                ? `Set hai${updatedAt ? ` (last change ${fmtDateTime(updatedAt)})` : ""}. Har budget, budget wale package aur promo contest prize par maanga jayega.`
                : "Set nahi hai. Iske bina koi promo budget nahi ban sakta. Login password se alag rakho."}
            </p>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <button onClick={() => { setOpen((o) => !o); setResetOpen(false); }} className="text-sm font-medium text-primary whitespace-nowrap">
            {configured ? "Change" : "Set password"}
          </button>
          {configured && (
            <button onClick={() => { setResetOpen((o) => !o); setOpen(false); }} className="text-xs text-muted-foreground underline whitespace-nowrap">
              Bhool gaye? Reset
            </button>
          )}
        </div>
      </div>
      {resetOpen && <ApprovalReset onDone={() => setResetOpen(false)} />}
      {open && (
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          {configured && (
            <input type="password" className={field} placeholder="Purana approval password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="off" />
          )}
          <input type="password" className={field} placeholder="Naya (kam se kam 6)" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
          <input type="password" className={field} placeholder="Naya dobara" value={confirmNext} onChange={(e) => setConfirmNext(e.target.value)} autoComplete="new-password" />
          {mismatch ? <p className="text-xs text-red-600 sm:col-span-3">Dono naye password match nahi kar rahe.</p> : null}
          <div className="sm:col-span-3 flex justify-end">
            <button
              onClick={() => mut.mutate()}
              disabled={mut.isPending || next.length < 6 || next !== confirmNext || (configured && !current)}
              className="px-4 py-2 rounded-xl gradient-purple text-white text-sm font-semibold disabled:opacity-50"
            >
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Forgotten approval password: superadmin only. Step 1 emails a 6-digit code
 * to the superadmin's login email (may ask to sign in again first); step 2
 * sets a new password with that code. Worker lib/approvalPassword.ts.
 */
function ApprovalReset({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [next, setNext] = useState("");
  const [confirmNext, setConfirmNext] = useState("");
  const request = useMutation({
    mutationFn: () => api.requestApprovalReset(),
    onSuccess: (r) => {
      setSentTo(r.sentTo);
      toast.success(`Code bheja: ${r.sentTo}`);
    },
    onError: (e) => toast.error(describeError(e)),
  });
  const confirmReset = useMutation({
    mutationFn: () => api.confirmApprovalReset({ code: code.trim(), next }),
    onSuccess: () => {
      toast.success("Naya approval password set ho gaya");
      qc.invalidateQueries({ queryKey: ["approval-password"] });
      onDone();
    },
    onError: (e) => toast.error(describeError(e)),
  });
  return (
    <div className="mt-3 rounded-xl border border-border bg-background p-3 space-y-2">
      <p className="text-xs text-muted-foreground">
        Sirf superadmin reset kar sakta hai. Aapke login email par 6 digit ka code jayega, phir naya password set karo.
      </p>
      {!sentTo ? (
        <button
          onClick={() => request.mutate()}
          disabled={request.isPending}
          className="px-4 py-2 rounded-xl gradient-purple text-white text-sm font-semibold disabled:opacity-50"
        >
          Email par code bhejo
        </button>
      ) : (
        <div className="grid gap-2 sm:grid-cols-3">
          <input className={field} inputMode="numeric" maxLength={6} placeholder={`Code (${sentTo})`} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} autoComplete="one-time-code" />
          <input type="password" className={field} placeholder="Naya (kam se kam 6)" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
          <input type="password" className={field} placeholder="Naya dobara" value={confirmNext} onChange={(e) => setConfirmNext(e.target.value)} autoComplete="new-password" />
          {confirmNext.length > 0 && next !== confirmNext ? <p className="text-xs text-red-600 sm:col-span-3">Dono naye password match nahi kar rahe.</p> : null}
          <div className="sm:col-span-3 flex justify-end gap-2">
            <button onClick={() => request.mutate()} disabled={request.isPending} className="px-3 py-2 rounded-xl bg-secondary text-xs font-medium">
              Code dobara bhejo
            </button>
            <button
              onClick={() => confirmReset.mutate()}
              disabled={confirmReset.isPending || code.length !== 6 || next.length < 6 || next !== confirmNext}
              className="px-4 py-2 rounded-xl gradient-purple text-white text-sm font-semibold disabled:opacity-50"
            >
              Reset
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Contests / Packages ─────────────────────────────────────────────────────

function ContestsPnl() {
  const { data = [], isLoading, error } = useQuery({ queryKey: ["coin-economy-contests"], queryFn: api.coinEconomyContests });
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <CsvButton onClick={() => exportCsv("contest-pnl.csv", data, ["id", "title", "status", "totalEntryFee", "rewardCoins", "matches", "won", "feesIn", "refunds", "prizes", "subsidy", "subsidyHeld", "platformKept", "net"])} />
      </div>
      {error ? <ErrorBox error={error} /> : null}
      <Table
        loading={isLoading}
        data={data}
        keyFn={(c) => c.id}
        empty="Koi contest nahi"
        columns={[
          {
            key: "t",
            header: "Contest",
            render: (c) => (
              <span>
                <span className="font-medium text-foreground">{c.title ?? c.id}</span>
                <span className="block text-xs text-muted-foreground">
                  fee {fmtNumber(c.totalEntryFee)} · prize {c.prizeType === "product" ? `product${c.prizeCostCoins ? ` (${fmtNumber(c.prizeCostCoins)} coin value)` : ""}` : fmtNumber(c.rewardCoins)}
                  {c.subsidyBudgetId ? " · promo" : ""} · {c.status}
                </span>
              </span>
            ),
          },
          { key: "m", header: "Matches", className: "text-right", render: (c) => <span>{fmtNumber(c.matches)}<span className="block text-xs text-muted-foreground">{c.won} won · {c.live} live</span></span> },
          { key: "f", header: "Entry fee aayi", className: "text-right", render: (c) => fmtNumber(c.feesIn) },
          { key: "r", header: "Refund", className: "text-right", render: (c) => fmtNumber(c.refunds) },
          { key: "p", header: "Prize diya", className: "text-right", render: (c) => fmtNumber(c.prizes) },
          { key: "s", header: "Budget se diya", className: "text-right", render: (c) => <span className="text-red-600">{fmtNumber(c.subsidy)}{c.subsidyHeld ? <span className="block text-xs text-amber-600">{fmtNumber(c.subsidyHeld)} reserved</span> : null}</span> },
          { key: "k", header: "Platform ne rakha", className: "text-right", render: (c) => <span className="text-green-600">{fmtNumber(c.platformKept)}</span> },
        ]}
      />
    </div>
  );
}

function PackagesPnl() {
  const { data = [], isLoading, error } = useQuery({ queryKey: ["coin-economy-packages"], queryFn: api.coinEconomyPackages });
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <CsvButton onClick={() => exportCsv("package-pnl.csv", data, ["id", "name", "purchases", "inr", "refundedInr", "baseCoins", "bonusCoinsGiven", "promoBonusGiven"])} />
      </div>
      {error ? <ErrorBox error={error} /> : null}
      <Table
        loading={isLoading}
        data={data}
        keyFn={(p) => p.id}
        empty="Abhi koi purchase nahi"
        columns={[
          {
            key: "n",
            header: "Package",
            render: (p) => (
              <span>
                <span className="font-medium text-foreground">{p.name ?? p.id}</span>
                <span className="block text-xs text-muted-foreground">
                  {fmtNumber(p.coins)} + {fmtNumber(p.bonusCoins)} bonus{p.budgetId ? " · promo budget" : ""}{p.active ? "" : " · hidden"}
                </span>
              </span>
            ),
          },
          { key: "c", header: "Purchases", className: "text-right", render: (p) => fmtNumber(p.purchases) },
          { key: "i", header: "₹ aaya", className: "text-right", render: (p) => <span>{inr(p.inr)}{p.refundedInr ? <span className="block text-xs text-red-600">−{inr(p.refundedInr)} refund</span> : null}</span> },
          { key: "b", header: "Paid coins", className: "text-right", render: (p) => fmtNumber(p.baseCoins) },
          { key: "x", header: "Bonus coins", className: "text-right", render: (p) => <span>{fmtNumber(p.bonusCoinsGiven)}{p.promoBonusGiven ? <span className="block text-xs text-purple-600">{fmtNumber(p.promoBonusGiven)} budget se (locked)</span> : null}</span> },
        ]}
      />
    </div>
  );
}

// ─── User statement ──────────────────────────────────────────────────────────

function UserStatementView() {
  const [q, setQ] = useState("");
  const [uid, setUid] = useState<string | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ["coin-economy-user", uid],
    queryFn: () => api.coinEconomyUser(uid!, 2000),
    enabled: !!uid,
  });
  return (
    <div className="space-y-4">
      <form
        className="flex gap-2 max-w-lg"
        onSubmit={(e) => {
          e.preventDefault();
          if (q.trim()) setUid(q.trim());
        }}
      >
        <input className={field} placeholder="User uid ya username" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="px-4 rounded-xl gradient-purple text-white text-sm font-semibold flex items-center gap-1"><Search size={14} /> Dekho</button>
      </form>
      {isLoading && uid ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {error ? <ErrorBox error={error} /> : null}
      {data && (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard icon={Coins} label={`${data.user.username ?? data.user.uid} ka balance`} value={fmtNumber(data.user.balance)} gradient="gradient-purple" />
            <StatCard icon={Wallet} label="Withdraw ho sakte hain" value={fmtNumber(data.user.withdrawable)} gradient="gradient-green" />
            <StatCard icon={Gift} label="Locked (promo)" value={fmtNumber(data.user.locked)} gradient="gradient-orange" />
          </div>
          <div className={`rounded-xl px-4 py-2 text-sm ${data.ledger.balanced ? "bg-green-50 text-green-800" : "bg-red-50 text-red-800"}`}>
            {data.ledger.balanced
              ? `Hisab barabar: ${fmtNumber(data.ledger.count)} ledger rows ka total = balance.`
              : `Mismatch: ledger total ${fmtNumber(data.ledger.sum)} (locked ${fmtNumber(data.ledger.lockedSum)}) vs balance ${fmtNumber(data.user.balance)} (locked ${fmtNumber(data.user.locked)}).`}
            {data.truncated ? " Sirf latest 2000 rows dikhaye hain." : ""}
          </div>
          <div className="flex justify-end">
            <CsvButton onClick={() => exportCsv(`coins-${data.user.uid}.csv`, data.entries, ["createdAt", "type", "amount", "lockedDelta", "balanceAfter", "lockedAfter", "contestId", "matchId", "budgetId", "description", "id"])} />
          </div>
          <Table
            data={data.entries}
            keyFn={(e) => e.id}
            empty="Koi transaction nahi"
            columns={[
              { key: "t", header: "Kab", render: (e) => <span className="text-xs whitespace-nowrap">{fmtDateTime(e.createdAt)}</span> },
              { key: "ty", header: "Type", render: (e) => <span><span className="font-mono text-xs">{e.type}</span>{e.budgetId ? <span className="block text-xs text-purple-600">budget</span> : null}</span> },
              { key: "a", header: "Coins", className: "text-right", render: (e) => <span className={e.amount < 0 ? "text-red-600" : "text-green-600"}>{signed(e.amount)}</span> },
              { key: "l", header: "Locked", className: "text-right", render: (e) => (e.lockedDelta ? <span className="text-amber-600">{signed(e.lockedDelta)}</span> : <span className="text-muted-foreground">—</span>) },
              { key: "b", header: "Balance baad me", className: "text-right", render: (e) => <span>{fmtNumber(e.balanceAfter)}{e.lockedAfter ? <span className="block text-xs text-amber-600">{fmtNumber(e.lockedAfter)} locked</span> : null}</span> },
              { key: "d", header: "Detail", render: (e) => <span className="text-xs text-muted-foreground">{e.description}</span> },
            ]}
          />
        </>
      )}
    </div>
  );
}

// ─── bits ────────────────────────────────────────────────────────────────────

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-card border border-border rounded-2xl p-5">
      <p className="font-semibold text-foreground mb-3">{title}</p>
      {children}
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: React.ReactNode; strong?: boolean }) {
  return (
    <div className={`flex items-center justify-between gap-3 py-1.5 text-sm ${strong ? "border-t border-border mt-1 pt-2 font-semibold" : ""}`}>
      <span className={strong ? "text-foreground" : "text-muted-foreground"}>{label}</span>
      <span className="text-foreground">{value}</span>
    </div>
  );
}

function CsvButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex items-center gap-1 text-sm font-medium text-primary">
      <Download size={14} /> CSV export
    </button>
  );
}

function ErrorBox({ error }: { error: unknown }) {
  return <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{describeError(error)}</div>;
}

function Overlay({ children, onClose, wide }: { children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={onClose}>
      <div
        className={`bg-card border border-border rounded-2xl p-6 w-full ${wide ? "max-w-3xl" : "max-w-md"} max-h-[90vh] overflow-y-auto`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
