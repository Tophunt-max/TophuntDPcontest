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
exports.joinContest = void 0;
const https_1 = require("firebase-functions/v2/https");
const admin = __importStar(require("firebase-admin"));
const sender_1 = require("../notifications/sender");
/**
 * Join a contest and handle the VS pairing logic.
 * Coin deduction happens ONLY when a pair is formed.
 */
exports.joinContest = (0, https_1.onCall)(async (request) => {
    // 1. Authenticate User
    if (!request.auth) {
        throw new https_1.HttpsError("unauthenticated", "User must be logged in.");
    }
    const { contestId, mediaUrl, caption, username, displayName } = request.data;
    const userId = request.auth.uid;
    if (!contestId || !mediaUrl) {
        throw new https_1.HttpsError("invalid-argument", "Missing contestId or mediaUrl.");
    }
    const db = admin.firestore();
    try {
        const result = await db.runTransaction(async (transaction) => {
            var _a, _b;
            // 2. Get Contest Details
            const contestRef = db.collection("contests").doc(contestId);
            const contestDoc = await transaction.get(contestRef);
            if (!contestDoc.exists) {
                throw new https_1.HttpsError("not-found", "Contest not found.");
            }
            const contestData = contestDoc.data();
            if (contestData.status !== "live") {
                throw new https_1.HttpsError("failed-precondition", "Contest is not live.");
            }
            // 3. Check if User already in this contest
            const existingEntryQuery = db.collection("entries")
                .where("contestId", "==", contestId)
                .where("userId", "==", userId)
                .limit(1);
            const existingEntrySnap = await transaction.get(existingEntryQuery);
            if (!existingEntrySnap.empty) {
                throw new https_1.HttpsError("already-exists", "You have already joined this contest.");
            }
            // 4. Check for Waiting Opponent
            const waitingQuery = db.collection("entries")
                .where("contestId", "==", contestId)
                .where("status", "==", "waiting")
                .orderBy("createdAt", "asc")
                .limit(1);
            const waitingSnap = await transaction.get(waitingQuery);
            if (waitingSnap.empty) {
                // NO OPPONENT: Create a waiting entry (No coin deduction yet)
                const entryId = db.collection("entries").doc().id;
                const newEntry = {
                    id: entryId,
                    contestId,
                    userId,
                    username,
                    userDisplayName: displayName,
                    mediaUrl,
                    caption: caption || "",
                    status: "waiting",
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                };
                transaction.set(db.collection("entries").doc(entryId), newEntry);
                return { status: "waiting", message: "Joined! Waiting for an opponent." };
            }
            else {
                // OPPONENT FOUND: Create Battle + Deduct Coins
                const opponentEntry = waitingSnap.docs[0].data();
                const opponentId = opponentEntry.userId;
                if (opponentId === userId) {
                    throw new https_1.HttpsError("failed-precondition", "You cannot battle yourself.");
                }
                // Check Coins for both users
                const userRef = db.collection("users").doc(userId);
                const opponentRef = db.collection("users").doc(opponentId);
                const [userDoc, opponentDoc] = await Promise.all([
                    transaction.get(userRef),
                    transaction.get(opponentRef)
                ]);
                const entryFeePerUser = contestData.entryFishCoins / 2;
                if ((((_a = userDoc.data()) === null || _a === void 0 ? void 0 : _a.fishCoins) || 0) < entryFeePerUser) {
                    throw new https_1.HttpsError("failed-precondition", "Insufficient Fish Coins.");
                }
                if ((((_b = opponentDoc.data()) === null || _b === void 0 ? void 0 : _b.fishCoins) || 0) < entryFeePerUser) {
                    throw new https_1.HttpsError("failed-precondition", "Opponent has insufficient coins.");
                }
                // 5. Deduct Coins from both
                transaction.update(userRef, {
                    fishCoins: admin.firestore.FieldValue.increment(-entryFeePerUser),
                    "stats.contestsJoined": admin.firestore.FieldValue.increment(1)
                });
                transaction.update(opponentRef, {
                    fishCoins: admin.firestore.FieldValue.increment(-entryFeePerUser),
                    "stats.contestsJoined": admin.firestore.FieldValue.increment(1)
                });
                // 6. Create Battle
                const battleId = db.collection("battles").doc().id;
                const newBattle = {
                    id: battleId,
                    contestId,
                    contestName: contestData.name,
                    contestType: contestData.type,
                    userA: {
                        userId: opponentId,
                        username: opponentEntry.username,
                        displayName: opponentEntry.userDisplayName,
                        mediaUrl: opponentEntry.mediaUrl,
                        votes: 0,
                    },
                    userB: {
                        userId: userId,
                        username: username,
                        displayName: displayName,
                        mediaUrl: mediaUrl,
                        votes: 0,
                    },
                    totalVotes: 0,
                    status: "active",
                    endDate: contestData.endDate,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                };
                transaction.set(db.collection("battles").doc(battleId), newBattle);
                // 7. Update Entries to 'paired'
                transaction.update(db.collection("entries").doc(opponentEntry.id), {
                    status: "paired",
                    battleId
                });
                const currentEntryId = db.collection("entries").doc().id;
                transaction.set(db.collection("entries").doc(currentEntryId), {
                    id: currentEntryId,
                    contestId,
                    userId,
                    username,
                    userDisplayName: displayName,
                    mediaUrl,
                    caption: caption || "",
                    status: "paired",
                    battleId,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                });
                // 8. Create Transaction Records
                const transARef = db.collection("coin_transactions").doc();
                const transBRef = db.collection("coin_transactions").doc();
                transaction.set(transARef, {
                    userId: opponentId, amount: -entryFeePerUser, type: "entry_fee", contestId, battleId, description: `Entry fee for contest ${contestData.name}`, createdAt: admin.firestore.FieldValue.serverTimestamp(),
                });
                transaction.set(transBRef, {
                    userId, amount: -entryFeePerUser, type: "entry_fee", contestId, battleId, description: `Entry fee for contest ${contestData.name}`, createdAt: admin.firestore.FieldValue.serverTimestamp(),
                });
                return {
                    status: "paired",
                    battleId,
                    message: "Battle started!",
                    opponentId, // Return for notification
                    contestName: contestData.name
                };
            }
        });
        // 9. Send Push Notifications AFTER Transaction Successful
        if (result.status === "paired") {
            await Promise.all([
                (0, sender_1.sendPushNotification)(result.opponentId, "Opponent Found! ⚔️", `Your battle in ${result.contestName} has started!`, "battle_started"),
                (0, sender_1.sendPushNotification)(userId, "Battle Live! 🚀", `You are now competing in ${result.contestName}!`, "battle_started")
            ]);
        }
        return result;
    }
    catch (error) {
        console.error("Error in joinContest:", error);
        throw new https_1.HttpsError("internal", "Something went wrong.");
    }
});
//# sourceMappingURL=joinContest.js.map