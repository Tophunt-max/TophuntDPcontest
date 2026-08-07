// Sanity-check the D1 database via the Worker (row counts).
// Usage: node scripts/check-db.mjs
import { adminApi } from "./lib/worker.mjs";

try {
  const o = await adminApi("/overview");
  console.log("D1 connectivity OK. Current counts:");
  console.log(`  users:   ${o.users}`);
  console.log(`  posts:   ${o.posts}`);
  console.log(`  reports: ${o.reports}`);
  console.log(`  open support tickets: ${o.support}`);
  process.exit(0);
} catch (e) {
  console.error("Error checking D1:", e.message);
  process.exit(1);
}
