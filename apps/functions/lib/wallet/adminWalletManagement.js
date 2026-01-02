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
exports.adminManageWallet = void 0;
const https_1 = require("firebase-functions/v2/https");
const admin = __importStar(require("firebase-admin"));
const ADMIN_WALLET_CONFIG = {
    region: "us-central1", // Cheaper region
    cpu: 1, // Increased to 1
    concurrency: 80,
    memory: "256MiB",
    minInstances: 0,
    maxInstances: 2,
    cors: true
};
/**
 * Admin function to add or subtract Fish Coins for a user.
 */
exports.adminManageWallet = (0, https_1.onCall)(ADMIN_WALLET_CONFIG, async (request) => {
    // TODO: Implement robust admin authentication and authorization here.
    // For now, we'll proceed assuming the caller from the admin panel is authorized.
    if (!request.auth) {
        throw new https_1.HttpsError("unauthenticated", "Admin must be logged in.");
    }
    const adminId = request.auth.uid; // Assign to a local variable after the check
    const { userId, amount, type } = request.data;
    if (!userId || typeof amount !== "number" || amount <= 0 || !["add", "subtract"].includes(type)) {
        throw new https_1.HttpsError("invalid-argument", "Invalid request parameters.");
    }
    const db = admin.firestore();
    let newCoinBalance = 0; // Initialize outside the transaction
    try {
        await db.runTransaction(async (transaction) => {
            var _a;
            const userRef = db.collection("users").doc(userId);
            const userDoc = await transaction.get(userRef);
            if (!userDoc.exists) {
                throw new https_1.HttpsError("not-found", "User not found.");
            }
            const currentCoins = ((_a = userDoc.data()) === null || _a === void 0 ? void 0 : _a.fishCoins) || 0;
            if (type === "add") {
                newCoinBalance = currentCoins + amount;
            }
            else {
                if (currentCoins < amount) {
                    throw new https_1.HttpsError("failed-precondition", "Not enough coins to subtract.");
                }
                newCoinBalance = currentCoins - amount;
            }
            // Update user's coin balance
            transaction.update(userRef, {
                fishCoins: newCoinBalance,
            });
            // Log Transaction History
            const transRef = db.collection("coin_transactions").doc();
            transaction.set(transRef, {
                userId,
                amount: type === "add" ? amount : -amount,
                type: `admin-${type}`,
                description: `Admin ${type === "add" ? "added" : "subtracted"} ${amount} Fish Coins`,
                adminId: adminId, // Use the local variable here
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });
        });
        return { success: true, message: `Successfully ${type === "add" ? "added" : "subtracted"} ${amount} coins for user ${userId}.`, newBalance: newCoinBalance };
    }
    catch (error) {
        console.error("Error in adminManageWallet:", error);
        if (error instanceof https_1.HttpsError) {
            throw error;
        }
        throw new https_1.HttpsError("internal", "Failed to manage user wallet.");
    }
});
//# sourceMappingURL=adminWalletManagement.js.map