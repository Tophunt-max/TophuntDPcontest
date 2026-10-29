import { Link } from "wouter";
import { SettingsEditor } from "@/components/SettingsEditor";
import { api } from "@/lib/api";

// Coin rewards have forms with validation in Coin Economy → Earn
// (components/coin/EarnCards.tsx). XP, levels, ranks, milestones and quests
// live in Gamification → Rules (pages/Gamification.tsx), which validates them
// and asks for the approval password when coins are at stake; the Worker
// refuses curve changes from this raw editor (routes/admin.ts POST /rewards).
const COIN_KEYS = ["dailyLoginReward", "dailyBaseReward", "dailyStreakBonus", "dailyTasks", "hallOfFameRewards"];
const XP_KEYS = ["progression", "xpThreshold", "xpIncrement"];

const hint = (keys: string[]) => {
  const xp = keys.filter((k) => XP_KEYS.includes(k));
  const coin = keys.filter((k) => COIN_KEYS.includes(k));
  return [
    xp.length ? `${xp.join(", ")}: Gamification → Rules me badlo.` : "",
    coin.length ? `${coin.join(", ")}: Coin Economy → Earn me badlo.` : "",
  ].filter(Boolean).join(" ");
};

export default function Rewards() {
  return (
    <div>
      <div className="mb-4 rounded-xl border border-border bg-secondary/40 px-4 py-3 text-sm">
        XP, levels, ranks, milestones aur quests ab{" "}
        <Link href="/gamification" className="font-semibold text-primary underline">Gamification (XP &amp; Levels)</Link>{" "}
        page par form ke saath edit hote hain.
      </div>
      <SettingsEditor
        title="Rewards & Gamification (advanced)"
        subtitle="Baaki raw settings (JSON). Coin wale rewards Coin Economy → Earn me, aur XP / levels Gamification page par edit karo."
        queryKey="rewards"
        load={api.rewards}
        save={api.saveRewards}
        omitKeys={[...COIN_KEYS, ...XP_KEYS]}
        omitHint={hint}
      />
    </div>
  );
}
