import { SettingsEditor } from "@/components/SettingsEditor";
import { api } from "@/lib/api";

// Coin rewards have forms with validation in Coin Economy → Earn
// (components/coin/EarnCards.tsx); this raw editor keeps XP, levels, badges.
const COIN_KEYS = ["dailyLoginReward", "dailyBaseReward", "dailyStreakBonus", "dailyTasks", "hallOfFameRewards"];

export default function Rewards() {
  return (
    <SettingsEditor
      title="Rewards & Gamification"
      subtitle="XP, levels aur badges (raw JSON). Coin wale rewards — daily login, streak bonus, daily tasks, Hall of Fame — Coin Economy → Earn me form ke saath edit karo."
      queryKey="rewards"
      load={api.rewards}
      save={api.saveRewards}
      omitKeys={COIN_KEYS}
    />
  );
}
