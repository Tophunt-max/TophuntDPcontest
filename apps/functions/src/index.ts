import { setGlobalOptions } from "firebase-functions/v2";
import { onCall } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { masterApiRouter } from "./api/main";
import { scheduledTasks } from "./scheduled";

// Import Auth Handler (Merged Version)
import { authHandler } from "./auth/authHandler";

// GLOBAL SETTINGS
setGlobalOptions({
  region: "us-central1",
  cpu: 1,
  memory: "256MiB",
  maxInstances: 2,
  concurrency: 80,
});

/**
 * AUTH SYSTEM (Merged into one function)
 */
export { authHandler };

/**
 * MASTER API FUNCTION:
 * Auth ke ilawa baaki sabhi actions ke liye.
 */
export const api = onCall(async (request) => {
  return await masterApiRouter(request);
});

/**
 * BACKGROUND TASKS
 */
export const scheduled = onSchedule("every 10 minutes", async (event) => {
    await scheduledTasks(event);
});
