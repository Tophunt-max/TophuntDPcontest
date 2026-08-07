// Make a user an admin (sets the Firebase custom claim + D1 users.role).
// Usage: node scripts/makeAdmin.mjs <email>
//        node scripts/makeAdmin.mjs            (defaults to tophuntinfo@gmail.com)
import { adminApi } from "./lib/worker.mjs";

const email = process.argv[2] || "tophuntinfo@gmail.com";

try {
  const res = await adminApi("/set-role", { method: "POST", body: { email, makeAdmin: true } });
  console.log(`Successfully set admin role for ${email} (uid: ${res.uid}).`);
  process.exit(0);
} catch (e) {
  console.error("Error setting admin role:", e.message);
  process.exit(1);
}
