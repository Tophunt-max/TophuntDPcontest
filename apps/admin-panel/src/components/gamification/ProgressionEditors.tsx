import { useEffect, useState } from "react";

/**
 * Row editors for the progression lists (ranks, level milestones, quests) in
 * Gamification → Rules. The Worker validates every field again
 * (worker lib/progression.ts `validateProgression`); these forms only keep the
 * shape right so admins never hand-edit JSON.
 */

const input = "w-full px-2 py-1.5 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring";
const small = "bg-secondary text-foreground text-xs font-medium px-2 py-1 rounded-lg disabled:opacity-40";

export interface RankRow { id: string; name: string; minLevel: number; icon: string; color: string }
export interface MilestoneRow { level: number; title: string; description: string; items: string[]; feature: string | null; coins: number }
export interface QuestRow { id: string; title: string; period: "week" | "month"; metric: string; target: number; xp: number; minLevel: number; enabled: boolean }

export const QUEST_METRICS = ["votes", "entries", "wins", "checkins", "active_days", "xp"];

/** Number input that keeps what is typed; "" stays "" so the Worker's message explains it. */
function NumberCell({ value, onChange, min, className }: { value: number | ""; onChange: (v: number | "") => void; min?: number; className?: string }) {
  return (
    <input type="number" min={min} className={`${input} ${className ?? "w-20"}`} value={value}
      onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))} />
  );
}

/** Comma/space separated ids. Keeps the raw text while typing, commits a clean list. */
function IdListCell({ value, onChange, listId }: { value: string[]; onChange: (v: string[]) => void; listId?: string }) {
  const [text, setText] = useState(value.join(", "));
  useEffect(() => setText(value.join(", ")), [value.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <input className={input} list={listId} placeholder="frame_bronze, title_creator" value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => onChange(text.split(/[\s,]+/).filter(Boolean))} />
  );
}

function RowActions({ i, n, move, remove }: { i: number; n: number; move: (from: number, to: number) => void; remove: (i: number) => void }) {
  return (
    <div className="flex gap-1 justify-end">
      <button type="button" className={small} disabled={i === 0} onClick={() => move(i, i - 1)} aria-label="Move up">↑</button>
      <button type="button" className={small} disabled={i === n - 1} onClick={() => move(i, i + 1)} aria-label="Move down">↓</button>
      <button type="button" className={`${small} text-red-600`} onClick={() => remove(i)}>Remove</button>
    </div>
  );
}

function useRows<T>(rows: T[], onChange: (rows: T[]) => void) {
  return {
    set: (i: number, patch: Partial<T>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r))),
    remove: (i: number) => onChange(rows.filter((_, j) => j !== i)),
    move: (from: number, to: number) => {
      const next = [...rows];
      const [r] = next.splice(from, 1);
      next.splice(to, 0, r);
      onChange(next);
    },
    add: (row: T) => onChange([...rows, row]),
  };
}

const th = "text-left text-xs font-medium text-muted-foreground px-1 pb-2 whitespace-nowrap";
const td = "px-1 py-1 align-top";

export function RanksEditor({ rows, onChange }: { rows: RankRow[]; onChange: (rows: RankRow[]) => void }) {
  const r = useRows(rows, onChange);
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead><tr><th className={th}>Id</th><th className={th}>Name</th><th className={th}>From level</th><th className={th}>Icon</th><th className={th}>Color</th><th /></tr></thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              <td className={td}><input className={input} value={row.id} onChange={(e) => r.set(i, { id: e.target.value })} /></td>
              <td className={td}><input className={input} value={row.name} onChange={(e) => r.set(i, { name: e.target.value })} /></td>
              <td className={td}><NumberCell min={1} value={row.minLevel} onChange={(v) => r.set(i, { minLevel: v as number })} /></td>
              <td className={td}><input className={`${input} w-28`} value={row.icon} onChange={(e) => r.set(i, { icon: e.target.value })} /></td>
              <td className={td}>
                <div className="flex gap-1 items-center">
                  <input type="color" className="h-8 w-10 rounded border border-border bg-background" value={/^#[0-9a-f]{6}$/i.test(row.color) ? row.color : "#000000"} onChange={(e) => r.set(i, { color: e.target.value.toUpperCase() })} />
                  <input className={`${input} w-24 font-mono`} value={row.color} onChange={(e) => r.set(i, { color: e.target.value })} />
                </div>
              </td>
              <td className={td}><RowActions i={i} n={rows.length} move={r.move} remove={r.remove} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className={`${small} mt-2`} disabled={rows.length >= 20}
        onClick={() => r.add({ id: "", name: "", minLevel: (rows[rows.length - 1]?.minLevel ?? 0) + 1, icon: "trophy", color: "#8B5CF6" })}>+ Add rank</button>
    </div>
  );
}

export function MilestonesEditor({ rows, onChange, itemIds }: { rows: MilestoneRow[]; onChange: (rows: MilestoneRow[]) => void; itemIds: string[] }) {
  const r = useRows(rows, onChange);
  return (
    <div className="overflow-x-auto">
      <datalist id="gam-item-ids">{itemIds.map((id) => <option key={id} value={id} />)}</datalist>
      <table className="w-full">
        <thead><tr><th className={th}>Level</th><th className={th}>Title</th><th className={th}>Description</th><th className={th}>Items (catalog ids)</th><th className={th}>Feature key</th><th className={th}>Diamond</th><th /></tr></thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              <td className={td}><NumberCell min={1} value={row.level} onChange={(v) => r.set(i, { level: v as number })} /></td>
              <td className={td}><input className={`${input} min-w-[140px]`} value={row.title} onChange={(e) => r.set(i, { title: e.target.value })} /></td>
              <td className={td}><input className={`${input} min-w-[200px]`} value={row.description} onChange={(e) => r.set(i, { description: e.target.value })} /></td>
              <td className={`${td} min-w-[200px]`}><IdListCell listId="gam-item-ids" value={row.items} onChange={(items) => r.set(i, { items })} /></td>
              <td className={td}><input className={`${input} w-36`} placeholder="none" value={row.feature ?? ""} onChange={(e) => r.set(i, { feature: e.target.value.trim() || null })} /></td>
              <td className={td}><NumberCell min={0} value={row.coins} onChange={(v) => r.set(i, { coins: v as number })} /></td>
              <td className={td}><RowActions i={i} n={rows.length} move={r.move} remove={r.remove} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className={`${small} mt-2`} disabled={rows.length >= 200}
        onClick={() => r.add({ level: (Math.max(0, ...rows.map((m) => Number(m.level) || 0))) + 1, title: "", description: "", items: [], feature: null, coins: 0 })}>+ Add milestone</button>
      {itemIds.length > 0 && <p className="text-xs text-muted-foreground mt-2">Catalog ids: {itemIds.join(", ")}</p>}
    </div>
  );
}

export function QuestsEditor({ rows, onChange }: { rows: QuestRow[]; onChange: (rows: QuestRow[]) => void }) {
  const r = useRows(rows, onChange);
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead><tr><th className={th}>Id</th><th className={th}>Title</th><th className={th}>Period</th><th className={th}>Metric</th><th className={th}>Target</th><th className={th}>XP</th><th className={th}>Min level</th><th className={th}>On</th><th /></tr></thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              <td className={td}><input className={`${input} min-w-[130px]`} value={row.id} onChange={(e) => r.set(i, { id: e.target.value })} /></td>
              <td className={td}><input className={`${input} min-w-[200px]`} value={row.title} onChange={(e) => r.set(i, { title: e.target.value })} /></td>
              <td className={td}>
                <select className={input} value={row.period} onChange={(e) => r.set(i, { period: e.target.value as QuestRow["period"] })}>
                  <option value="week">week</option><option value="month">month</option>
                </select>
              </td>
              <td className={td}>
                <select className={input} value={row.metric} onChange={(e) => r.set(i, { metric: e.target.value })}>
                  {QUEST_METRICS.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </td>
              <td className={td}><NumberCell min={1} value={row.target} onChange={(v) => r.set(i, { target: v as number })} /></td>
              <td className={td}><NumberCell min={0} value={row.xp} onChange={(v) => r.set(i, { xp: v as number })} /></td>
              <td className={td}><NumberCell min={1} value={row.minLevel} onChange={(v) => r.set(i, { minLevel: v as number })} /></td>
              <td className={`${td} text-center`}><input type="checkbox" className="mt-2" checked={row.enabled !== false} onChange={(e) => r.set(i, { enabled: e.target.checked })} /></td>
              <td className={td}><RowActions i={i} n={rows.length} move={r.move} remove={r.remove} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className={`${small} mt-2`} disabled={rows.length >= 30}
        onClick={() => r.add({ id: "", title: "", period: "week", metric: "votes", target: 10, xp: 20, minLevel: 1, enabled: true })}>+ Add quest</button>
    </div>
  );
}
