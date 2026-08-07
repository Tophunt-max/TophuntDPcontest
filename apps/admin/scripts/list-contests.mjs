// List all contest templates from D1 (via the Worker).
// Usage: node scripts/list-contests.mjs
import { adminApi } from "./lib/worker.mjs";

try {
  const contests = await adminApi("/contests");
  if (!contests.length) {
    console.log('No contests found.');
  } else {
    console.log(`Found ${contests.length} contests:`);
    for (const c of contests) console.log(`- ${c.id}:`, c);
  }
  process.exit(0);
} catch (e) {
  console.error("Error:", e.message);
  process.exit(1);
}
