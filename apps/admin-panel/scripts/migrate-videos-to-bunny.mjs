// Migrate existing R2-hosted videos to Bunny Stream (MEDIA_MIGRATION_PLAN.md Phase 3).
//
// Usage:
//   node scripts/migrate-videos-to-bunny.mjs                  # everything, batches of 10
//   node scripts/migrate-videos-to-bunny.mjs --target=matches  # contest entries only
//   node scripts/migrate-videos-to-bunny.mjs --limit=25 --max-batches=4
//   node scripts/migrate-videos-to-bunny.mjs --status         # just print progress
//
// Recommended order (per the plan): contest entries first — they are longer and
// higher-stakes than stories — then stories.
//   node scripts/migrate-videos-to-bunny.mjs --target=matches
//   node scripts/migrate-videos-to-bunny.mjs --target=stories
//
// How it behaves:
//   * The Bunny API key stays in the Worker. This script only calls
//     POST /admin/videos/migrate-batch with the ADMIN_PROXY_SECRET.
//   * Bunny pulls each file from its R2 URL (fetch-from-URL) — nothing is
//     downloaded or re-uploaded here.
//   * Resumable and safe to re-run: enqueued rows are marked `migrating` so a
//     second run never re-enqueues them.
//   * `mediaUrl` is NOT repointed at enqueue time. The Worker's Bunny webhook
//     performs the cutover once each encode reports `ready`, so playback keeps
//     working from R2 for the whole migration window.
//   * R2 originals are deliberately NOT deleted. Delete them only after ~30 days
//     of confirmed Bunny playback.
import { adminApi } from "./lib/worker.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const target = flag("target", "all");
const limit = Number(flag("limit", "10"));
const maxBatches = Number(flag("max-batches", "1000"));
const pauseMs = Number(flag("pause", "1000"));

if (!["all", "stories", "matches"].includes(target)) {
  console.error(`Invalid --target=${target}. Use all | stories | matches.`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function printStatus() {
  const s = await adminApi("/videos/migration-status");
  const byStatus = (s.videosByStatus || [])
    .map((r) => `${r.status}=${r.count}`)
    .join(" ") || "none";
  console.log(`\nBunny videos:   ${byStatus}`);
  console.log(`Still on R2:    stories=${s.pending?.stories ?? "?"} matches=${s.pending?.matches ?? "?"}`);
}

if (has("status")) {
  await printStatus();
  process.exit(0);
}

console.log(`Migrating R2 videos -> Bunny Stream (target=${target}, batch=${limit})`);
await printStatus();
console.log("");

let totals = { scanned: 0, enqueued: 0, failed: 0 };

for (let batch = 1; batch <= maxBatches; batch++) {
  let res;
  try {
    res = await adminApi("/videos/migrate-batch", {
      method: "POST",
      body: { target, limit },
    });
  } catch (e) {
    // A failed-precondition here almost always means Bunny is not configured on
    // the Worker yet.
    console.error(`\nBatch ${batch} failed: ${e.message}`);
    process.exit(1);
  }

  totals.scanned += res.scanned || 0;
  totals.enqueued += res.enqueued || 0;
  totals.failed += res.failed || 0;

  console.log(
    `batch ${String(batch).padStart(3)}  scanned=${res.scanned}  enqueued=${res.enqueued}  failed=${res.failed}`,
  );
  for (const err of res.errors || []) console.warn(`   ! ${err}`);

  if (res.done) {
    console.log("\nNothing left to enqueue.");
    break;
  }
  // Be gentle with Bunny's API and D1's single writer.
  if (batch < maxBatches) await sleep(pauseMs);
}

console.log(
  `\nTotals: scanned=${totals.scanned} enqueued=${totals.enqueued} failed=${totals.failed}`,
);
await printStatus();
console.log(
  "\nEncoding runs asynchronously. Re-run with --status to watch rows move to 'ready';\n" +
    "each one cuts over to Bunny automatically when its webhook fires.\n" +
    "Do NOT delete the R2 originals yet.",
);
process.exit(totals.failed > 0 ? 1 : 0);
