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
const firebase_1 = require("../utils/firebase");
const sender_1 = require("../notifications/sender");
const gamification_1 = require("../utils/gamification");
const JOIN_CONFIG = {
    region: "us-central1",
    cpu: 1, // Increased to 1 to support concurrency
    memory: "256MiB",
    minInstances: 0,
    maxInstances: 2,
    concurrency: 80,
    cors: true
};
/**
 * Join a contest and handle the VS pairing logic.
 * Coin deduction happens ONLY when a pair is formed.
 */
exports.joinContest = (0, https_1.onCall)(JOIN_CONFIG, async (request) => {
    // 1. Authenticate User
    if (!request.auth) {
        throw new https_1.HttpsError("unauthenticated", "User must be logged in.");
    }
    const { contestId, mediaUrl, caption, username, displayName } = request.data;
    const userId = request.auth.uid;
    if (!contestId || !mediaUrl) {
        throw new https_1.HttpsError("invalid-argument", "Missing contestId or mediaUrl.");
    }
    try {
        // PRE-TRANSACTION: Check if user already joined (Query)
        const existingEntryQueryOld = firebase_1.db.collection("entries")
            .where("contestId", "==", contestId)
            .where("userId", "==", userId)
            .limit(1);
        const existingEntryQueryA = firebase_1.db.collection("entries")
            .where("contestId", "==", contestId)
            .where("userId_A", "==", userId)
            .limit(1);
        const existingEntryQueryB = firebase_1.db.collection("entries")
            .where("contestId", "==", contestId)
            .where("userId_B", "==", userId)
            .limit(1);

        const [existingEntrySnapOld, existingEntrySnapA, existingEntrySnapB] = await Promise.all([
            existingEntryQueryOld.get(),
            existingEntryQueryA.get(),
            existingEntryQueryB.get()
        ]);

        if (!existingEntrySnapOld.empty || !existingEntrySnapA.empty || !existingEntrySnapB.empty) {
            throw new https_1.HttpsError("already-exists", "You have already joined this contest.");
        }

        // PRE-TRANSACTION: Find a potential opponent (Query)
        const waitingQuery = firebase_1.db.collection("entries")
            .where("contestId", "==", contestId)
            .where("status", "==", "waiting")
            .orderBy("createdAt", "asc")
            .limit(1);
        const waitingSnap = await waitingQuery.get();
        let potentialOpponentRef = null;
        if (!waitingSnap.empty) {
            potentialOpponentRef = waitingSnap.docs[0].ref;
        }
        const result = await firebase_1.db.runTransaction(async (transaction) => {
            var _a, _b;
            // 2. Get Contest Details
            const contestRef = firebase_1.db.collection("contests").doc(contestId);
            const contestDoc = await transaction.get(contestRef);
            if (!contestDoc.exists) {
                throw new https_1.HttpsError("not-found", "Contest not found.");
            }
            const contestData = contestDoc.data();
            if (contestData.status !== "live") {
                throw new https_1.HttpsError("failed-precondition", "Contest is not live.");
            }
            // 3. Re-verify opponent inside transaction
            let opponentEntryData = null;
            let opponentEntryRef = null;
            if (potentialOpponentRef) {
                const freshOpponentDoc = await transaction.get(potentialOpponentRef);
                if (freshOpponentDoc.exists) {
                    const data = freshOpponentDoc.data();
                    let normalizedData = data;
                    // Normalize data to new format if it's an old entry (lacks userId_A but has userId)
                    if (data && data.userId && !data.userId_A) {
                        normalizedData = {
                            ...data,
                            userId_A: data.userId,
                            username_A: data.username,
                            userDisplayName_A: data.userDisplayName,
                            mediaUrl_A: data.mediaUrl,
                            caption_A: data.caption || "",
                            // Ensure old fields are effectively ignored or removed if desired
                            // For now, leaving them as is, but new code will use _A fields
                        };
                    }
                    // Ensure still waiting and not self (though self check covered by existingEntry check)
                    if (normalizedData && normalizedData.status === "waiting" && normalizedData.userId_A !== userId) {
                        opponentEntryData = normalizedData;
                        opponentEntryRef = freshOpponentDoc.ref;
                    }
                }
            }
            if (!opponentEntryData) {
                // NO OPPONENT (or opponent taken/invalid): Create a waiting entry
                const entryId = firebase_1.db.collection("entries").doc().id;
                const newEntry = {
                    id: entryId,
                    contestId,
                    userId_A: userId,
                    username_A: username,
                    userDisplayName_A: displayName,
                    mediaUrl_A: mediaUrl,
                    caption_A: caption || "",
                    status: "waiting",
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                };
                transaction.set(firebase_1.db.collection("entries").doc(entryId), newEntry);
                return { status: "waiting", message: "Joined! Waiting for an opponent." };
            }
            else {
                // OPPONENT FOUND: Update opponent's entry to be a paired battle entry
                const opponentId = opponentEntryData.userId_A;
                const userRef = firebase_1.db.collection("users").doc(userId);
                const opponentRef = firebase_1.db.collection("users").doc(opponentId);
                const [userDoc, opponentDoc] = await Promise.all([
                    transaction.get(userRef),
                    transaction.get(opponentRef)
                ]);
                const entryFeePerUser = contestData.entryFishCoins / 2;
                if ((((_a = userDoc.data()) === null || _a === void 0 ? void 0 : _a.fishCoins) || 0) < entryFeePerUser) {
                    throw new https_1.HttpsError("failed-precondition", "Insufficient Fish Coins.");
                }
                if ((((_b = opponentDoc.data()) === null || _b === void 0 ? void 0 : _b.fishCoins) || 0) < entryFeePerUser) {
                    // Edge case: Opponent went broke while waiting. Current user still joins as waiting.
                    const entryId = firebase_1.db.collection("entries").doc().id;
                    const newEntry = {
                        id: entryId,
                        contestId,
                        userId_A: userId,
                        username_A: username,
                        userDisplayName_A: displayName,
                        mediaUrl_A: mediaUrl,
                        caption_A: caption || "",
                        status: "waiting",
                        createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    };
                    transaction.set(firebase_1.db.collection("entries").doc(entryId), newEntry);
                    return { status: "waiting", message: "Joined! Waiting for an opponent (Opponent disqualified)." };
                }
                // Deduct Coins
                transaction.update(userRef, {
                    fishCoins: admin.firestore.FieldValue.increment(-entryFeePerUser),
                    "stats.contestsJoined": admin.firestore.FieldValue.increment(1)
                });
                transaction.update(opponentRef, {
                    fishCoins: admin.firestore.FieldValue.increment(-entryFeePerUser),
                    "stats.contestsJoined": admin.firestore.FieldValue.increment(1)
                });
                // Create Battle
                const voteDurationDays = contestData.voteDurationDays || 1;
                const battleEndDate = admin.firestore.Timestamp.fromMillis(Date.now() + (voteDurationDays * 24 * 60 * 60 * 1000));
                const battleId = firebase_1.db.collection("battles").doc().id;
                const newBattle = {
                    id: battleId,
                    contestId,
                    contestName: contestData.name,
                    contestType: contestData.type || 'photo',
                    userA: {
                        userId: opponentEntryData.userId_A,
                        username: opponentEntryData.username_A,
                        displayName: opponentEntryData.userDisplayName_A,
                        mediaUrl: opponentEntryData.mediaUrl_A,
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
                    endDate: battleEndDate,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                };
                transaction.set(firebase_1.db.collection("battles").doc(battleId), newBattle);
                // Update the existing opponent entry to reflect the pairing and add current user's data
                transaction.update(opponentEntryRef, {
                    userId_B: userId,
                    username_B: username,
                    userDisplayName_B: displayName,
                    mediaUrl_B: mediaUrl,
                    caption_B: caption || "",
                    status: "paired",
                    battleId,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                });
                // Transaction Records
                const transARef = firebase_1.db.collection("coin_transactions").doc();
                const transBRef = firebase_1.db.collection("coin_transactions").doc();
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
                    opponentId,
                    contestName: contestData.name
                };
            }
        });
        // 9. Send Push Notifications & Award XP
        if (result.status === "paired") {
            await Promise.all([
                (0, sender_1.sendPushNotification)(result.opponentId, "Opponent Found! ⚔️", `Your battle in ${result.contestName} has started!`, "battle_started"),
                (0, sender_1.sendPushNotification)(userId, "Battle Live! 🚀", `You are now competing in ${result.contestName}!`, "battle_started")
            ]);
        }
        // Award XP for joining (50 XP)
        (0, gamification_1.awardXp)(userId, 50, "contest_join").catch(err => console.error("XP Award Failed:", err));
        // Award XP to opponent as well if paired
        if (result.status === "paired" && result.opponentId) {
            (0, gamification_1.awardXp)(result.opponentId, 50, "contest_join").catch(err => console.error("XP Award Failed for opponent:", err));
        }
        return result;
    }
    catch (error) {
        console.error("Error in joinContest:", error);
        if (error.code && error.details) {
            throw error;
        }
        throw new https_1.HttpsError("internal", error.message || "Something went wrong.");
    }
});
//# sourceMappingURL=joinContest.js.map