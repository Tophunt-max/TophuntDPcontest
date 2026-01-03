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
exports.topUpWallet = void 0;
const https_1 = require("firebase-functions/v2/https");
const admin = __importStar(require("firebase-admin"));
const WALLET_CONFIG = {
    region: "us-central1", // Cheaper region
    cpu: 1, // Increased to 1
    concurrency: 80,
    memory: "256MiB",
    minInstances: 0,
    maxInstances: 2,
    cors: true
};
/**
 * Top-up Fish Coins for a user after successful payment.
 */
exports.topUpWallet = (0, https_1.onCall)(WALLET_CONFIG, async (request) => {
    if (!request.auth) {
        throw new https_1.HttpsError("unauthenticated", "User must be logged in.");
    }
    const { amount, paymentId } = request.data;
    const userId = request.auth.uid;
    if (!amount || amount <= 0) {
        throw new https_1.HttpsError("invalid-argument", "Invalid amount.");
    }
    const db = admin.firestore();
    try {
        await db.runTransaction(async (transaction) => {
            const userRef = db.collection("users").doc(userId);
            // Check if payment ID already processed to prevent duplicates
            const paymentRef = db.collection("payments").doc(paymentId);
            const paymentDoc = await transaction.get(paymentRef);
            if (paymentDoc.exists) {
                throw new https_1.HttpsError("already-exists", "Payment already processed.");
            }
            // Add Coins
            transaction.update(userRef, {
                Dpcoin: admin.firestore.FieldValue.increment(amount)
            });
            // Log Payment
            transaction.set(paymentRef, {
                userId,
                amount,
                status: "success",
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            // Log Transaction History
            const transRef = db.collection("coin_transactions").doc();
            transaction.set(transRef, {
                userId,
                amount: amount,
                type: "purchase",
                description: `Purchased ${amount} Fish Coins`,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });
        });
        return { success: true, message: "Coins added successfully!" };
    }
    catch (error) {
        console.error("Error in topUpWallet:", error);
        throw new https_1.HttpsError("internal", "Failed to add coins.");
    }
});
//# sourceMappingURL=topup.js.map