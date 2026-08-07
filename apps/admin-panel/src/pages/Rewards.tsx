import { SettingsEditor } from "@/components/SettingsEditor";
import { api } from "@/lib/api";

export default function Rewards() {
  return (
    <SettingsEditor
      title="Rewards & Gamification"
      subtitle="XP, levels, streaks, badges and daily-reward configuration"
      queryKey="rewards"
      load={api.rewards}
      save={api.saveRewards}
    />
  );
}
