import { SettingsEditor } from "@/components/SettingsEditor";
import { api } from "@/lib/api";

export default function Rewards() {
  return (
    <SettingsEditor
      title="Rewards & Gamification"
      subtitle="XP, levels aur badges (raw JSON). Coin wale rewards — daily login, streak bonus, daily tasks, Hall of Fame — Coin Economy → Earn me form ke saath edit karo."
      queryKey="rewards"
      load={api.rewards}
      save={api.saveRewards}
    />
  );
}
