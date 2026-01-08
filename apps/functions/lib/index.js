"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.onMatchComment = exports.onMatchLike = exports.onPostComment = exports.onPostLike = exports.scheduled = exports.api = exports.authHandler = void 0;
const v2_1 = require("firebase-functions/v2");
const https_1 = require("firebase-functions/v2/https");
const scheduler_1 = require("firebase-functions/v2/scheduler");
const main_1 = require("./api/main");
const scheduled_1 = require("./scheduled");
// Handlers
const authHandler_1 = require("./auth/authHandler");
Object.defineProperty(exports, "authHandler", { enumerable: true, get: function () { return authHandler_1.authHandler; } });
const notificationTriggers = __importStar(require("./notifications/triggers"));
// GLOBAL SETTINGS
(0, v2_1.setGlobalOptions)({
    region: "us-central1",
    cpu: 1,
    memory: "256MiB",
    maxInstances: 2,
    concurrency: 80,
});
/**
 * MASTER API FUNCTION
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
/**
 * NOTIFICATION TRIGGERS
 */
exports.onPostLike = notificationTriggers.onPostLike;
exports.onPostComment = notificationTriggers.onPostComment;
exports.onMatchLike = notificationTriggers.onMatchLike;
exports.onMatchComment = notificationTriggers.onMatchComment;
//# sourceMappingURL=index.js.map