import { HttpsError } from "firebase-functions/v2/https";
import { db } from "../utils/firebase";
import { FieldValue } from "firebase-admin/firestore";

/**
 * CLAIM PRIZE ACTION
 * Allows winners to submit shipping details for physical products.
 */
export const claimPrize = async (request: any) => {
    const { matchId, shippingInfo } = request.data;
    const uid = request.auth.uid;

    if (!matchId || !shippingInfo) {
        throw new HttpsError("invalid-argument", "Match ID and Shipping Info are required.");
    }

    const { fullName, phone, address, city, state, pincode } = shippingInfo;
    if (!fullName || !phone || !address || !pincode) {
        throw new HttpsError("invalid-argument", "Incomplete shipping details.");
    }

    try {
        const matchRef = db.collection("contestMatches").doc(matchId);
        const matchDoc = await matchRef.get();

        if (!matchDoc.exists) throw new HttpsError("not-found", "Match not found.");
        
        const matchData = matchDoc.data()!;

        // 1. Security Check: Only the winner can claim
        if (matchData.winnerId !== uid) {
            throw new HttpsError("permission-denied", "Only the winner can claim this prize.");
        }

        // 2. Check if already claimed
        if (matchData.isPrizeClaimed) {
            throw new HttpsError("already-exists", "Prize has already been claimed for this match.");
        }

        // 3. Create Claim Record
        const claimRef = db.collection("prizeClaims").doc(matchId);
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
                submittedAt: FieldValue.serverTimestamp()
            },
            status: "pending", // pending, processed, shipped, delivered
            trackingId: null,
            carrier: null,
            updatedAt: FieldValue.serverTimestamp()
        });

        // 4. Mark match as claimed
        await matchRef.update({
            isPrizeClaimed: true,
            claimedAt: FieldValue.serverTimestamp()
        });

        return { success: true, message: "Prize claim submitted successfully!" };

    } catch (e: any) {
        if (e instanceof HttpsError) throw e;
        console.error("Claim Prize Error:", e);
        throw new HttpsError("internal", e.message);
    }
};
