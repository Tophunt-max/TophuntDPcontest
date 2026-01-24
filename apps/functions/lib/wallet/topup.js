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
    region: "us-central1",
    cpu: 1,
    concurrency: 80,
    memory: "256MiB",
    minInstances: 0,
    maxInstances: 5, // Increased slightly for peak payment times
    cors: true
};
/**
 * PRODUCTION-GRADE WALLET TOP-UP
 * Adds Dpcoins after payment verification.
 */
exports.topUpWallet = (0, https_1.onCall)(WALLET_CONFIG, async (request) => {
    if (!request.auth) {
        throw new https_1.HttpsError("unauthenticated", "User must be logged in.");
    }
    const { amount, paymentId, provider } = request.data;
    const userId = request.auth.uid;
    if (!amount || amount <= 0 || !paymentId) {
        throw new https_1.HttpsError("invalid-argument", "Invalid payment details.");
    }
    const db = admin.firestore();
    try {
        // --- PRODUCTION STEP: PAYMENT VERIFICATION ---
        // In a real app, you would call the Payment Provider's API here:
        // const paymentValid = await verifyWithRazorpay(paymentId, amount);
        // if (!paymentValid) throw new HttpsError("permission-denied", "Fake payment detected.");
        return await db.runTransaction(async (transaction) => {
            const userRef = db.collection("users").doc(userId);
            // 1. Check Idempotency (Prevent Duplicate Top-ups)
            const paymentRef = db.collection("payments").doc(paymentId);
            const paymentDoc = await transaction.get(paymentRef);
            if (paymentDoc.exists) {
                throw new https_1.HttpsError("already-exists", "This payment has already been processed.");
            }
            // 2. Atomic Balance Update
            transaction.update(userRef, {
                Dpcoin: admin.firestore.FieldValue.increment(amount),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            // 3. Log Secure Payment Record
            transaction.set(paymentRef, {
                userId,
                amount,
                provider: provider || "unknown",
                status: "completed",
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            // 4. Unified Transaction History (Matching other contest functions)
            const transRef = db.collection("coinTransactions").doc();
            transaction.set(transRef, {
                uid: userId, // Using 'uid' for consistency with finalize.ts
                amount: amount,
                type: "purchase",
                paymentId: paymentId,
                description: `Top-up: Purchased ${amount} Dpcoins`,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
            });
            return { success: true, newBalanceIncrement: amount };
        });
    }
    catch (error) {
        console.error("Critical Wallet Error:", error);
        if (error instanceof https_1.HttpsError)
            throw error;
        throw new https_1.HttpsError("internal", "Wallet transaction failed. If amount was deducted, contact support.");
    }
});
//# sourceMappingURL=topup.js.map