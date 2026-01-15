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
exports.syncUserProfileUpdates = void 0;
const firestore_1 = require("firebase-functions/v2/firestore");
const firebase_1 = require("../utils/firebase");
const logger = __importStar(require("firebase-functions/logger"));
/**
 * Triggered when a user profile is updated.
 * Syncs the new profile picture (Cloudflare optimized) and display name everywhere.
 */
exports.syncUserProfileUpdates = (0, firestore_1.onDocumentUpdated)("users/{userId}", async (event) => {
    var _a, _b;
    const newData = (_a = event.data) === null || _a === void 0 ? void 0 : _a.after.data();
    const oldData = (_b = event.data) === null || _b === void 0 ? void 0 : _b.before.data();
    const userId = event.params.userId;
    if (!newData || !oldData)
        return;
    // Detect changes
    const photoChanged = newData.profileImageUrl !== oldData.profileImageUrl;
    const nameChanged = newData.fullName !== oldData.fullName || newData.username !== oldData.username;
    if (!photoChanged && !nameChanged)
        return;
    const updates = [];
    const newAvatar = newData.profileImageUrl || newData.photoURL || "";
    const newName = newData.fullName || newData.displayName || newData.username || "User";
    logger.info(`[Sync] Updating profile for ${userId} to: ${newAvatar}`);
    // 1. Update Comments across ALL posts (Collection Group)
    // NOTE: This requires a Firestore index. If index is missing, this will log an error.
    try {
        const commentsSnapshot = await firebase_1.db.collectionGroup('comments')
            .where('userId', '==', userId)
            .get();
        if (!commentsSnapshot.empty) {
            const batch = firebase_1.db.batch();
            commentsSnapshot.docs.forEach((doc) => {
                batch.update(doc.ref, {
                    userAvatar: newAvatar, // Updated to match your CommentSheet field
                    username: newName
                });
            });
            updates.push(batch.commit());
            logger.info(`[Sync] Queued ${commentsSnapshot.size} comment updates`);
        }
    }
    catch (error) {
        logger.error("[Sync] Error syncing comments (Index might be missing)", error);
    }
    // 2. Update Stories
    try {
        const storiesSnapshot = await firebase_1.db.collection('stories')
            .where('userId', '==', userId)
            .get();
        if (!storiesSnapshot.empty) {
            const batch = firebase_1.db.batch();
            storiesSnapshot.docs.forEach((doc) => {
                batch.update(doc.ref, {
                    avatarUrl: newAvatar,
                    username: newName
                });
            });
            updates.push(batch.commit());
        }
    }
    catch (error) {
        logger.error("[Sync] Error syncing stories", error);
    }
    // 3. Update Contest Matches
    try {
        const matchesASnapshot = await firebase_1.db.collection('contestMatches').where('userA.uid', '==', userId).get();
        if (!matchesASnapshot.empty) {
            const batch = firebase_1.db.batch();
            matchesASnapshot.docs.forEach(doc => {
                batch.update(doc.ref, {
                    'userA.profilePic': newAvatar,
                    'userA.username': newName
                });
            });
            updates.push(batch.commit());
        }
        const matchesBSnapshot = await firebase_1.db.collection('contestMatches').where('userB.uid', '==', userId).get();
        if (!matchesBSnapshot.empty) {
            const batch = firebase_1.db.batch();
            matchesBSnapshot.docs.forEach(doc => {
                batch.update(doc.ref, {
                    'userB.profilePic': newAvatar,
                    'userB.username': newName
                });
            });
            updates.push(batch.commit());
        }
    }
    catch (error) {
        logger.error("[Sync] Error syncing matches", error);
    }
    await Promise.all(updates);
    logger.info(`[Sync] Completed successfully for user: ${userId}`);
});
//# sourceMappingURL=syncProfile.js.map