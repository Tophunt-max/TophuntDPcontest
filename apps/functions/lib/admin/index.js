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
exports.adminHandler = void 0;
const https_1 = require("firebase-functions/v2/https");
const admin = __importStar(require("firebase-admin"));
const firebase_1 = require("../utils/firebase");
/**
 * UNIFIED ADMIN HANDLER
 * Consolidates all admin actions into a single protected entry point.
 */
exports.adminHandler = (0, https_1.onCall)({
    region: "us-central1",
    memory: "256MiB",
    maxInstances: 5, // Admin tasks are infrequent
    cors: true
}, async (request) => {
    var _a;
    // 1. Authentication Check
    if (!request.auth) {
        throw new https_1.HttpsError("unauthenticated", "Authentication required.");
    }
    const callerUid = request.auth.uid;
    // 2. Authorization Check (Is Caller an Admin or Moderator?)
    const callerDoc = await firebase_1.db.collection("users").doc(callerUid).get();
    const callerRole = (_a = callerDoc.data()) === null || _a === void 0 ? void 0 : _a.role;
    if (!callerDoc.exists || (callerRole !== "admin" && callerRole !== "moderator")) {
        throw new https_1.HttpsError("permission-denied", "Only admins or moderators can perform this action.");
    }
    const { action, data } = request.data;
    if (!action)
        throw new https_1.HttpsError("invalid-argument", "Action is required.");
    try {
        switch (action) {
            case "setRole": {
                const { uid, role } = data;
                if (!uid || !role)
                    throw new https_1.HttpsError("invalid-argument", "UID and role are required.");
                // Set custom claims (for security) and update Firestore (for UI)
                await admin.auth().setCustomUserClaims(uid, { role });
                await firebase_1.db.collection("users").doc(uid).update({ role });
                return { message: `Successfully set role ${role} for user ${uid}` };
            }
            case "deletePost": {
                const { postId } = data;
                if (!postId)
                    throw new https_1.HttpsError("invalid-argument", "PostID is required.");
                await firebase_1.db.collection("posts").doc(postId).delete();
                // Optionally delete associated media if needed
                return { message: `Post ${postId} deleted successfully.` };
            }
            case "unblockUser": {
                const { uid } = data;
                if (!uid)
                    throw new https_1.HttpsError("invalid-argument", "UID is required.");
                await firebase_1.db.collection("users").doc(uid).update({
                    status: "active",
                    blocked: false
                });
                return { message: `User ${uid} has been unblocked.` };
            }
            case "manageWallet": {
                const { uid, amount, transactionType, reason } = data;
                if (!uid || amount === undefined)
                    throw new https_1.HttpsError("invalid-argument", "Missing data.");
                const userRef = firebase_1.db.collection("users").doc(uid);
                await userRef.update({
                    Dpcoin: admin.firestore.FieldValue.increment(transactionType === 'decrement' ? -amount : amount)
                });
                // Log the admin transaction
                await firebase_1.db.collection("coin_transactions").add({
                    userId: uid,
                    amount,
                    type: transactionType === 'decrement' ? 'admin_deduction' : 'admin_credit',
                    reason: reason || "Admin Adjustment",
                    timestamp: admin.firestore.FieldValue.serverTimestamp()
                });
                return { message: "Wallet adjusted successfully." };
            }
            case "deleteStory": {
                const { storyId } = data;
                if (!storyId)
                    throw new https_1.HttpsError("invalid-argument", "StoryID is required.");
                await firebase_1.db.collection("stories").doc(storyId).delete();
                return { message: `Story ${storyId} deleted.` };
            }
            default:
                throw new https_1.HttpsError("invalid-argument", `Unknown action: ${action}`);
        }
    }
    catch (error) {
        console.error("Admin Handler Error:", error);
        throw new https_1.HttpsError("internal", error.message || "Admin action failed.");
    }
});
//# sourceMappingURL=index.js.map