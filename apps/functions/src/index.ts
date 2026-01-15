import { onCall } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import { masterApiRouter } from "./api/main";
import { authHandler } from "./auth/authHandler";
import { syncUserProfileUpdates } from "./user/syncProfile";
import { notificationApiRouter } from "./api/notificationApi";
import { onStoryViewCreated } from "./stories/triggers/viewAggregation";
import { storyHandler } from "./stories/index";
import * as notifications from "./notifications/index"; // Unified notifications

if (admin.apps.length === 0) {
    admin.initializeApp();
}

// REST API via Callable
export const api = onCall({
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 60,
    cors: true,
}, masterApiRouter);

// Exporting Unified Services
export { 
    authHandler, 
    syncUserProfileUpdates, 
    onStoryViewCreated,
    storyHandler,
    notifications // This now includes ALL triggers (Social + Chat + Calls)
};

export const notificationApi = onCall({
    region: "us-central1",
    memory: "256MiB",
    cors: true
}, notificationApiRouter);
