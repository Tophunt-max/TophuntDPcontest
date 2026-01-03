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
exports.contestHandler = void 0;
const https_1 = require("firebase-functions/v2/https");
const admin = __importStar(require("firebase-admin"));
const firebase_1 = require("../utils/firebase");
const sender_1 = require("../notifications/sender");
const gamification_1 = require("../utils/gamification");
const CONTEST_CONFIG = {
    region: "us-central1",
    cpu: 1,
    memory: "256MiB",
    minInstances: 0,
    maxInstances: 2,
    concurrency: 80,
    cors: true
};
exports.contestHandler = (0, https_1.onCall)(CONTEST_CONFIG, async (request) => {
    if (!request.auth) {
        throw new https_1.HttpsError("unauthenticated", "User must be logged in.");
    }
    const { action } = request.data;
    if (!action || !["join", "vote"].includes(action)) {
        throw new https_1.HttpsError("invalid-argument", "Invalid action. Use 'join' or 'vote'.");
    }
    if (action === "join") {
        return handleJoin(request);
    }
    else {
        return handleVote(request);
    }
});
// --- JOIN LOGIC ---
async function handleJoin(request) {
    const { contestId, mediaUrl, caption, username, displayName } = request.data;
    const userId = request.auth.uid;
    if (!contestId || !mediaUrl) {
        throw new https_1.HttpsError("invalid-argument", "Missing contestId or mediaUrl.");
    }
    try {
        const existingEntryQuery = firebase_1.db.collection("entries")
            .where("contestId", "==", contestId)
            .where("userId", "==", userId)
            .limit(1);
        const existingEntrySnap = await existingEntryQuery.get();
        if (!existingEntrySnap.empty) {
            throw new https_1.HttpsError("already-exists", "You have already joined this contest.");
        }
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
            const contestRef = firebase_1.db.collection("contests").doc(contestId);
            const contestDoc = await transaction.get(contestRef);
            if (!contestDoc.exists) {
                throw new https_1.HttpsError("not-found", "Contest not found.");
            }
            const contestData = contestDoc.data();
            if (contestData.status !== "live") {
                throw new https_1.HttpsError("failed-precondition", "Contest is not live.");
            }
            let opponentEntry = null;
            if (potentialOpponentRef) {
                const freshOpponentDoc = await transaction.get(potentialOpponentRef);
                if (freshOpponentDoc.exists) {
                    const data = freshOpponentDoc.data();
                    if (data && data.status === "waiting" && data.userId !== userId) {
                        opponentEntry = data;
                    }
                }
            }
            if (!opponentEntry) {
                const entryId = firebase_1.db.collection("entries").doc().id;
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
                transaction.set(firebase_1.db.collection("entries").doc(entryId), newEntry);
                return { status: "waiting", message: "Joined! Waiting for an opponent." };
            }
            else {
                const opponentId = opponentEntry.userId;
                const userRef = firebase_1.db.collection("users").doc(userId);
                const opponentRef = firebase_1.db.collection("users").doc(opponentId);
                const [userDoc, opponentDoc] = await Promise.all([
                    transaction.get(userRef),
                    transaction.get(opponentRef)
                ]);
                const userData = userDoc.data();
                const opponentData = opponentDoc.data();
                // DEDUCTION LOGIC:
                const totalFee = Number(contestData.totalEntryFee || contestData.entryFishCoins || contestData.entryDpcoin || 0);
                const entryFeePerUser = totalFee / 2;
                const userBalance = Number((userData === null || userData === void 0 ? void 0 : userData.Dpcoin) || (userData === null || userData === void 0 ? void 0 : userData.fishCoins) || (userData === null || userData === void 0 ? void 0 : userData.coins) || 0);
                const opponentBalance = Number((opponentData === null || opponentData === void 0 ? void 0 : opponentData.Dpcoin) || (opponentData === null || opponentData === void 0 ? void 0 : opponentData.fishCoins) || (opponentData === null || opponentData === void 0 ? void 0 : opponentData.coins) || 0);
                if (userBalance < entryFeePerUser) {
                    throw new https_1.HttpsError("failed-precondition", "Insufficient Dpcoins to join.");
                }
                if (opponentBalance < entryFeePerUser) {
                    const entryId = firebase_1.db.collection("entries").doc().id;
                    const newEntry = {
                        id: entryId, contestId, userId, username, userDisplayName: displayName,
                        mediaUrl, caption: caption || "", status: "waiting",
                        createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    };
                    transaction.set(firebase_1.db.collection("entries").doc(entryId), newEntry);
                    return { status: "waiting", message: "Joined! Waiting for a new opponent." };
                }
                // Determine coin fields
                let userCoinField = "Dpcoin";
                if ((userData === null || userData === void 0 ? void 0 : userData.Dpcoin) === undefined && (userData === null || userData === void 0 ? void 0 : userData.fishCoins) !== undefined)
                    userCoinField = "fishCoins";
                else if ((userData === null || userData === void 0 ? void 0 : userData.Dpcoin) === undefined && (userData === null || userData === void 0 ? void 0 : userData.coins) !== undefined)
                    userCoinField = "coins";
                let opponentCoinField = "Dpcoin";
                if ((opponentData === null || opponentData === void 0 ? void 0 : opponentData.Dpcoin) === undefined && (opponentData === null || opponentData === void 0 ? void 0 : opponentData.fishCoins) !== undefined)
                    opponentCoinField = "fishCoins";
                else if ((opponentData === null || opponentData === void 0 ? void 0 : opponentData.Dpcoin) === undefined && (opponentData === null || opponentData === void 0 ? void 0 : opponentData.coins) !== undefined)
                    opponentCoinField = "coins";
                transaction.update(userRef, {
                    [userCoinField]: admin.firestore.FieldValue.increment(-entryFeePerUser),
                    "stats.contestsJoined": admin.firestore.FieldValue.increment(1)
                });
                transaction.update(opponentRef, {
                    [opponentCoinField]: admin.firestore.FieldValue.increment(-entryFeePerUser),
                    "stats.contestsJoined": admin.firestore.FieldValue.increment(1)
                });
                // Record transactions
                const transA = firebase_1.db.collection("coinTransactions").doc();
                transaction.set(transA, {
                    uid: userId, amount: -entryFeePerUser, type: "contest_entry_fee", contestId, timestamp: admin.firestore.FieldValue.serverTimestamp()
                });
                const transB = firebase_1.db.collection("coinTransactions").doc();
                transaction.set(transB, {
                    uid: opponentId, amount: -entryFeePerUser, type: "contest_entry_fee", contestId, timestamp: admin.firestore.FieldValue.serverTimestamp()
                });
                const voteDurationDays = contestData.voteDurationDays || 1;
                const battleEndDate = admin.firestore.Timestamp.fromMillis(Date.now() + (voteDurationDays * 24 * 60 * 60 * 1000));
                const battleId = firebase_1.db.collection("battles").doc().id;
                const newBattle = {
                    id: battleId,
                    contestId,
                    contestName: contestData.name,
                    contestType: contestData.type || 'photo',
                    userA: { userId: opponentId, username: opponentEntry.username, displayName: opponentEntry.userDisplayName, mediaUrl: opponentEntry.mediaUrl, votes: 0 },
                    userB: { userId: userId, username: username, displayName: displayName, mediaUrl: mediaUrl, votes: 0 },
                    totalVotes: 0,
                    status: "active",
                    entryFee: totalFee,
                    endDate: battleEndDate,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                };
                transaction.set(firebase_1.db.collection("battles").doc(battleId), newBattle);
                transaction.update(firebase_1.db.collection("entries").doc(opponentEntry.id), { status: "paired", battleId });
                const currentEntryId = firebase_1.db.collection("entries").doc().id;
                transaction.set(firebase_1.db.collection("entries").doc(currentEntryId), {
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
                return {
                    status: "paired",
                    battleId,
                    message: "Battle started!",
                    opponentId,
                    contestName: contestData.name
                };
            }
        });
        if (result.status === "paired") {
            try {
                await Promise.all([
                    (0, sender_1.sendPushNotification)(result.opponentId, "Opponent Found! ⚔️", `Your battle in ${result.contestName} has started!`, "battle_started"),
                    (0, sender_1.sendPushNotification)(userId, "Battle Live! 🚀", `You are now competing in ${result.contestName}!`, "battle_started")
                ]);
            }
            catch (notificationError) {
                console.error("Error sending push notifications:", notificationError);
            }
        }
        // DYNAMIC REWARD:
        await (0, gamification_1.awardReward)(userId, "contest_join").catch(err => console.error("Reward Award Failed:", err));
        return result;
    }
    catch (error) {
        console.error("Error in joinContest:", error);
        throw new https_1.HttpsError("internal", error.message || "Something went wrong.");
    }
}
// --- VOTE LOGIC ---
async function handleVote(request) {
    const { battleId, participantId } = request.data;
    const voterId = request.auth.uid;
    if (!battleId || !participantId) {
        throw new https_1.HttpsError("invalid-argument", "Missing battleId or participantId.");
    }
    try {
        await firebase_1.db.runTransaction(async (transaction) => {
            const battleRef = firebase_1.db.collection("battles").doc(battleId);
            const battleDoc = await transaction.get(battleRef);
            if (!battleDoc.exists)
                throw new https_1.HttpsError("not-found", "Battle not found.");
            const battleData = battleDoc.data();
            if (battleData.status !== "active")
                throw new https_1.HttpsError("failed-precondition", "Battle ended.");
            if (battleData.endDate.toDate() < new Date())
                throw new https_1.HttpsError("failed-precondition", "Contest expired.");
            const voteId = `${voterId}_${battleId}`;
            const voteRef = firebase_1.db.collection("votes").doc(voteId);
            const voteDoc = await transaction.get(voteRef);
            if (voteDoc.exists)
                throw new https_1.HttpsError("already-exists", "Already voted.");
            const isUserA = battleData.userA.userId === participantId;
            const isUserB = battleData.userB.userId === participantId;
            if (!isUserA && !isUserB)
                throw new https_1.HttpsError("invalid-argument", "Invalid participant.");
            transaction.set(voteRef, {
                id: voteId, battleId, voterId, votedFor: participantId, contestId: battleData.contestId, createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            const updateData = { totalVotes: admin.firestore.FieldValue.increment(1) };
            if (isUserA)
                updateData["userA.votes"] = admin.firestore.FieldValue.increment(1);
            else
                updateData["userB.votes"] = admin.firestore.FieldValue.increment(1);
            transaction.update(battleRef, updateData);
            const participantRef = firebase_1.db.collection("users").doc(participantId);
            transaction.update(participantRef, { "stats.totalVotesReceived": admin.firestore.FieldValue.increment(1) });
        });
        // DYNAMIC REWARD:
        await (0, gamification_1.awardReward)(voterId, "battle_vote").catch(err => console.error("Reward Award Failed:", err));
        return { success: true, message: "Vote recorded successfully!" };
    }
    catch (error) {
        console.error("Error in voteInBattle:", error);
        if (error instanceof https_1.HttpsError)
            throw error;
        throw new https_1.HttpsError("internal", "Voting failed.");
    }
}
//# sourceMappingURL=contestHandler.js.map