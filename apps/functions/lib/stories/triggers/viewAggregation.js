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
exports.onStoryViewCreated = void 0;
const firestore_1 = require("firebase-functions/v2/firestore");
const logger = __importStar(require("firebase-functions/logger"));
const firebase_1 = require("../../utils/firebase");
/**
 * Aggregates story views asynchronously.
 * Triggered when a new document is created in the storyViews/{storyId}/users/{userId} collection.
 * This ensures that the client-side view event is lightweight and non-blocking.
 *
 * Performance Note:
 * We use FieldValue.increment(1) which is atomic and efficient.
 * This runs in the background, keeping the UI thread free.
 */
exports.onStoryViewCreated = (0, firestore_1.onDocumentCreated)({
    document: "storyViews/{storyId}/users/{userId}",
    region: "us-central1",
    maxInstances: 5, // Allow concurrency for high traffic
    memory: "128MiB" // Lightweight function
}, async (event) => {
    const storyId = event.params.storyId;
    // const userId = event.params.userId; // Available if needed for analytics
    const storyRef = firebase_1.db.collection("stories").doc(storyId);
    try {
        // Check if story exists first (optional, but good for data integrity)
        // For max speed, we might skip this if we trust the client logic, 
        // but in a distributed system, it's safer to check or catch the error.
        // Increment the viewsCount
        await storyRef.update({
            viewsCount: firebase_1.admin.firestore.FieldValue.increment(1)
        });
        // logger.info(`Incremented viewsCount for story: ${storyId} by user ${userId}`);
    }
    catch (error) {
        // Handle case where story might be deleted while viewing
        logger.warn(`Error incrementing viewsCount for story: ${storyId}`, error);
    }
});
//# sourceMappingURL=viewAggregation.js.map