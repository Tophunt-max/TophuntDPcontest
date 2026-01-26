"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.claimPrize = void 0;
const https_1 = require("firebase-functions/v2/https");
const firebase_1 = require("../utils/firebase");
const firestore_1 = require("firebase-admin/firestore");
/**
 * CLAIM PRIZE ACTION
 * Allows winners to submit shipping details for physical products.
 */
const claimPrize = async (request) => {
    const { matchId, shippingInfo } = request.data;
    const uid = request.auth.uid;
    if (!matchId || !shippingInfo) {
        throw new https_1.HttpsError("invalid-argument", "Match ID and Shipping Info are required.");
    }
    const { fullName, phone, address, city, state, pincode } = shippingInfo;
    if (!fullName || !phone || !address || !pincode) {
        throw new https_1.HttpsError("invalid-argument", "Incomplete shipping details.");
    }
    try {
        const matchRef = firebase_1.db.collection("contestMatches").doc(matchId);
        const matchDoc = await matchRef.get();
        if (!matchDoc.exists)
            throw new https_1.HttpsError("not-found", "Match not found.");
        const matchData = matchDoc.data();
        // 1. Security Check: Only the winner can claim
        if (matchData.winnerId !== uid) {
            throw new https_1.HttpsError("permission-denied", "Only the winner can claim this prize.");
        }
        // 2. Check if already claimed
        if (matchData.isPrizeClaimed) {
            throw new https_1.HttpsError("already-exists", "Prize has already been claimed for this match.");
        }
        // 3. Create Claim Record
        const claimRef = firebase_1.db.collection("prizeClaims").doc(matchId);
        await claimRef.set({
            matchId,
            uid,
            contestTitle: matchData.title || "Contest",
            rewardType: matchData.rewardType || 'product',
            prizeName: matchData.prizeDescription || 'Contest Reward',
            shippingInfo: {
                fullName,
                phone,
                address,
                city: city || "",
                state: state || "",
                pincode,
                submittedAt: firestore_1.FieldValue.serverTimestamp()
            },
            status: "pending", // pending, processed, shipped, delivered
            trackingId: null,
            carrier: null,
            updatedAt: firestore_1.FieldValue.serverTimestamp()
        });
        // 4. Mark match as claimed
        await matchRef.update({
            isPrizeClaimed: true,
            claimedAt: firestore_1.FieldValue.serverTimestamp()
        });
        return { success: true, message: "Prize claim submitted successfully!" };
    }
    catch (e) {
        if (e instanceof https_1.HttpsError)
            throw e;
        console.error("Claim Prize Error:", e);
        throw new https_1.HttpsError("internal", e.message);
    }
};
exports.claimPrize = claimPrize;
//# sourceMappingURL=prizes.js.map