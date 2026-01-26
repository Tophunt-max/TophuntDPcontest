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
exports.monthlyHallOfFame = exports.contestMaintenance = exports.syncUserProfileUpdates = exports.contestHandler = exports.adminHandler = exports.authHandler = exports.storyHandler = exports.notify = exports.api = void 0;
const https_1 = require("firebase-functions/v2/https");
const admin = __importStar(require("firebase-admin"));
const main_1 = require("./api/main");
const authHandler_1 = require("./auth/authHandler");
Object.defineProperty(exports, "authHandler", { enumerable: true, get: function () { return authHandler_1.authHandler; } });
const syncProfile_1 = require("./user/syncProfile");
Object.defineProperty(exports, "syncUserProfileUpdates", { enumerable: true, get: function () { return syncProfile_1.syncUserProfileUpdates; } });
const index_1 = require("./stories/index");
Object.defineProperty(exports, "storyHandler", { enumerable: true, get: function () { return index_1.storyHandler; } });
const index_2 = require("./notifications/index");
Object.defineProperty(exports, "notify", { enumerable: true, get: function () { return index_2.notify; } });
const index_3 = require("./admin/index");
Object.defineProperty(exports, "adminHandler", { enumerable: true, get: function () { return index_3.adminHandler; } });
const handler_1 = require("./contests/handler");
Object.defineProperty(exports, "contestHandler", { enumerable: true, get: function () { return handler_1.contestHandler; } });
const cron_1 = require("./contests/cron");
Object.defineProperty(exports, "contestMaintenance", { enumerable: true, get: function () { return cron_1.contestMaintenance; } });
Object.defineProperty(exports, "monthlyHallOfFame", { enumerable: true, get: function () { return cron_1.monthlyHallOfFame; } });
if (admin.apps.length === 0) {
    admin.initializeApp();
}
/**
 * MAIN API GATEWAY
 */
exports.api = (0, https_1.onCall)({
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 60,
    cors: true,
}, main_1.masterApiRouter);
//# sourceMappingURL=index.js.map