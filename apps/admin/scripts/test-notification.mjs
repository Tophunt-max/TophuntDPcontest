// Send a test notification to a user (writes to D1 + FCM push, via the Worker).
// Usage: node scripts/test-notification.mjs <USER_UID>
import { adminApi } from "./lib/worker.mjs";

const uid = process.argv[2];
if (!uid) {
  console.log("Usage: node scripts/test-notification.mjs <USER_UID>");
  process.exit(1);
}

try {
  await adminApi("/notify", {
    method: "POST",
    body: {
      userId: uid,
      title: "Test Notification! 🚀",
      body: "Ye ek production-grade test notification hai.",
      type: "system",
    },
  });
  console.log(`Notification sent to ${uid}.`);
  process.exit(0);
} catch (e) {
  console.error("Error:", e.message);
  process.exit(1);
}
