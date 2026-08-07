// Seed a sample contest template into D1 (via the Worker).
// Usage: node scripts/seed-contests.mjs
import { adminApi } from "./lib/worker.mjs";

try {
  const res = await adminApi("/contests", {
    method: "POST",
    body: {
      title: "Best Instagram DP",
      type: "photo",
      description: "Show off your best profile picture!",
      rules: "1. Must be a portrait. 2. High quality.",
      totalEntryFee: 100,
      rewardCoins: 150,
      rewardXP: 100,
      minVotes: 5,
      durationHours: 24,
      autoCancelHours: 24,
      status: "live",
      bannerUrl: "https://images.unsplash.com/photo-1511367461989-f85a21fda167?w=800",
    },
  });
  console.log("Successfully seeded contest with ID:", res.contestId);
  process.exit(0);
} catch (e) {
  console.error("Error seeding contest:", e.message);
  process.exit(1);
}
