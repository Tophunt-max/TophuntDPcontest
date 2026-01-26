import { onCall } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import { masterApiRouter } from "./api/main";
import { authHandler } from "./auth/authHandler";
import { syncUserProfileUpdates } from "./user/syncProfile";
import { storyHandler } from "./stories/index";
import { notify } from "./notifications/index";
import { adminHandler } from "./admin/index";
import { contestHandler } from "./contests/handler";
import { contestMaintenance, monthlyHallOfFame } from "./contests/cron";

if (admin.apps.length === 0) {
    admin.initializeApp();
}

/**
 * MAIN API GATEWAY
 */
export const api = onCall({
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 60,
    cors: true,
}, masterApiRouter);

/**
 * UNIFIED SERVICES
 */
export { 
    notify, 
    storyHandler, 
    authHandler, 
    adminHandler, 
    contestHandler,
    syncUserProfileUpdates,
    contestMaintenance,
    monthlyHallOfFame
};
