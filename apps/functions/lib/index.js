"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.scheduled = exports.api = exports.authHandler = void 0;
const v2_1 = require("firebase-functions/v2");
const https_1 = require("firebase-functions/v2/https");
const scheduler_1 = require("firebase-functions/v2/scheduler");
const main_1 = require("./api/main");
const scheduled_1 = require("./scheduled");
// Import Auth Handler (Merged Version)
const authHandler_1 = require("./auth/authHandler");
Object.defineProperty(exports, "authHandler", { enumerable: true, get: function () { return authHandler_1.authHandler; } });
// GLOBAL SETTINGS
(0, v2_1.setGlobalOptions)({
    region: "us-central1",
    cpu: 1,
    memory: "256MiB",
    maxInstances: 2,
    concurrency: 80,
});
/**
 * MASTER API FUNCTION:
 * Auth ke ilawa baaki sabhi actions ke liye.
 */
exports.api = (0, https_1.onCall)(async (request) => {
    return await (0, main_1.masterApiRouter)(request);
});
/**
 * BACKGROUND TASKS
 */
exports.scheduled = (0, scheduler_1.onSchedule)("every 10 minutes", async (event) => {
    await (0, scheduled_1.scheduledTasks)(event);
});
//# sourceMappingURL=index.js.map