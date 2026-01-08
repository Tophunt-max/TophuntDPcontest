import { setGlobalOptions } from "firebase-functions/v2";
import { onCall } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { masterApiRouter } from "./api/main";
import { scheduledTasks } from "./scheduled";

// Handlers
import { authHandler } from "./auth/authHandler";
import * as notificationTriggers from "./notifications/triggers";

// Contest Handlers
import { resolveContests, monthlyHallOfFame } from "./contests/cron";

// GLOBAL SETTINGS
setGlobalOptions({
  region: "us-central1",
  cpu: 1,
  memory: "256MiB",
  maxInstances: 2,
  concurrency: 80,
});

/**
 * AUTH SYSTEM - Production Instance
 */
export { authHandler };

/**
 * MASTER API FUNCTION
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

// Contest Scheduled Tasks
export const resolveContestsTask = resolveContests;
export const monthlyHallOfFameTask = monthlyHallOfFame;

/**
 * NOTIFICATION TRIGGERS
 */
export const onPostLike = notificationTriggers.onPostLike;
export const onPostComment = notificationTriggers.onPostComment;
export const onMatchLike = notificationTriggers.onMatchLike;
export const onMatchComment = notificationTriggers.onMatchComment;
export const onCommentLike = notificationTriggers.onCommentLike;
export const onMatchCreated = notificationTriggers.onMatchCreated;
export const onMatchStatusUpdate = notificationTriggers.onMatchStatusUpdate;
export const onCoinTransaction = notificationTriggers.onCoinTransaction;
export const onUserFollow = notificationTriggers.onUserFollow;
export const onShare = notificationTriggers.onShare;
export const onProfileVisit = notificationTriggers.onProfileVisit;
export const onUserLevelUp = notificationTriggers.onUserLevelUp;
