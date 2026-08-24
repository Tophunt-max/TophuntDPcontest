import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import { api } from "@/lib/api";
import { Table } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { StatCard } from "@/components/ui/StatCard";
import { PageHeader, fmtDateTime, fmtNumber } from "@/lib/format";
import { IndianRupee, Coins, CreditCard, Wallet, Download, Search } from "lucide-react";

export default function Transactions() {
  const [type, setType] = useState("");
  const [uid, setUid] = useState("");
  const [uidInput, setUidInput] = useState("");

  const revenue = useQuery({ queryKey: ["revenue"], queryFn: api.revenue });
  const types = useQuery({ queryKey: ["txn-types"], queryFn: api.transactionTypes });
  const { data = [], isLoading } = useQuery({
    queryKey: ["transactions", type, uid],
    queryFn: () => api.transactions({ type: type || undefined, uid: uid || undefined, limit: 300 }),
  });

  const exportCsv = () => {
    const header = ["id", "uid", "username", "amount", "type", "description", "createdAt"];
    const rows = data.map((t: any) =>
      [t.id, t.uid, t.username || "", t.amount, t.type, (t.description || "").replace(/,/g, " "), t.createdAt].join(","),
    );
    const blob = new Blob([[header.join(","), ...rows].join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `transactions-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const field = "px-3 py-2 rounded-xl border border-border bg-card text-sm focus:outline-none focus:ring-2 focus:ring-ring";

  return (
    <div>
      <PageHeader title="Transactions & Revenue" subtitle="Coin ledger, top-ups and money flow" />

      {/* Revenue stat cards */}
      {/* Money and coins are different units and are labelled as such: "revenue"
          used to be a coin count rendered with a ₹ icon. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard icon={IndianRupee} label="Net Revenue (₹)" value={`₹${fmtNumber(revenue.data?.netRevenueInr ?? 0)}`} gradient="gradient-green" />
        <StatCard icon={CreditCard} label="Payments" value={fmtNumber(revenue.data?.paymentCount ?? 0)} gradient="gradient-blue" />
        <StatCard icon={Coins} label="Coins Sold" value={fmtNumber(revenue.data?.coinsSold ?? 0)} gradient="gradient-orange" />
        <StatCard icon={Wallet} label="Coins in Circulation" value={fmtNumber(revenue.data?.coinsInCirculation ?? 0)} gradient="gradient-purple" />
      </div>

      {(revenue.data?.refundedInr ?? 0) > 0 || (revenue.data?.paymentsWithoutRecordedAmount ?? 0) > 0 ? (
        <div className="mb-6 flex flex-wrap gap-3 text-xs">
          {(revenue.data?.refundedInr ?? 0) > 0 && (
            <span className="px-3 py-1.5 rounded-lg bg-red-500/10 text-red-600 font-medium">
              ₹{fmtNumber(revenue.data!.refundedInr)} refunded or charged back across{" "}
              {fmtNumber(revenue.data!.refundedCount)} payment(s) — excluded from net revenue
            </span>
          )}
          {(revenue.data?.paymentsWithoutRecordedAmount ?? 0) > 0 && (
            <span className="px-3 py-1.5 rounded-lg bg-amber-500/10 text-amber-600 font-medium">
              {fmtNumber(revenue.data!.paymentsWithoutRecordedAmount)} older payment(s) have no recorded
              rupee amount, so revenue is understated by that much
            </span>
          )}
        </div>
      ) : null}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        {/* Revenue trend */}
        <div className="lg:col-span-2 bg-card border border-border rounded-2xl p-5">
          <h3 className="font-bold text-foreground mb-1">Revenue (last 14 days)</h3>
          <p className="text-xs text-muted-foreground mb-4">Rupees from successful top-ups per day</p>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={revenue.data?.trend ?? []} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(220 13% 91%)" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} stroke="hsl(220 9% 46%)" tickFormatter={(d) => d.slice(5)} />
                <YAxis tick={{ fontSize: 12 }} stroke="hsl(220 9% 46%)" allowDecimals={false} />
                <Tooltip />
                <Bar dataKey="amount" fill="#22C55E" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Top spenders */}
        <div className="bg-card border border-border rounded-2xl p-5">
          <h3 className="font-bold text-foreground mb-4">Top Spenders</h3>
          <div className="space-y-2 max-h-56 overflow-auto">
            {(revenue.data?.topSpenders ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground py-6 text-center">No data</p>
            ) : (
              revenue.data!.topSpenders.map((s, i) => (
                <div key={s.userId} className="flex items-center gap-3 p-2 rounded-lg hover:bg-secondary/40">
                  <span className="w-6 h-6 rounded-full bg-secondary flex items-center justify-center text-xs font-bold">{i + 1}</span>
                  <span className="text-sm text-foreground flex-1 truncate">{s.fullName || s.username || s.userId}</span>
                  <span className="text-sm font-bold text-green-600">₹{fmtNumber(s.totalInr)}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <select className={field} value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">All types</option>
          {(types.data ?? []).map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <div className="relative">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={uidInput}
            onChange={(e) => setUidInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && setUid(uidInput.trim())}
            placeholder="Filter by user ID…"
            className={`${field} pl-9 w-56`}
          />
        </div>
        <button onClick={() => setUid(uidInput.trim())} className="px-4 py-2 rounded-xl bg-secondary text-sm font-medium">Apply</button>
        {uid && (
          <button onClick={() => { setUid(""); setUidInput(""); }} className="px-3 py-2 rounded-xl text-sm text-muted-foreground hover:text-foreground">Clear</button>
        )}
        <button onClick={exportCsv} className="ml-auto flex items-center gap-2 px-4 py-2 rounded-xl bg-secondary text-sm font-medium hover:bg-secondary/70">
          <Download size={15} /> Export CSV
        </button>
      </div>

      <Table
        loading={isLoading}
        data={data}
        keyFn={(t: any) => t.id}
        empty="No transactions found"
        columns={[
          {
            key: "user",
            header: "User",
            render: (t: any) => (
              <div className="min-w-0">
                <p className="font-medium text-foreground truncate">{t.fullName || t.username || "Unknown"}</p>
                <p className="text-xs text-muted-foreground truncate">{t.uid}</p>
              </div>
            ),
          },
          {
            key: "amount",
            header: "Amount",
            render: (t: any) => (
              <span className={`font-bold ${t.amount >= 0 ? "text-green-600" : "text-red-600"}`}>
                {t.amount >= 0 ? "+" : ""}{fmtNumber(t.amount)}
              </span>
            ),
          },
          { key: "type", header: "Type", render: (t: any) => <Badge variant={t.amount >= 0 ? "success" : "danger"}>{t.type}</Badge> },
          { key: "desc", header: "Description", render: (t: any) => <span className="text-muted-foreground">{t.description || "—"}</span> },
          { key: "date", header: "Date", render: (t: any) => <span className="text-muted-foreground">{fmtDateTime(t.createdAt)}</span> },
        ]}
      />
    </div>
  );
}
