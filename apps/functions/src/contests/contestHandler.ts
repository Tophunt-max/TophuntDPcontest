import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import { db } from "../utils/firebase";
import { sendPushNotification } from "../notifications/sender";
import { awardReward } from "../utils/gamification";
import { MemoryOption } from "firebase-functions/v2/options";

const CONTEST_CONFIG = {
    region: "us-central1", 
    cpu: 1, 
    memory: "256MiB" as MemoryOption, 
    minInstances: 0,
    maxInstances: 2,
    concurrency: 80, 
    cors: true
};

export const contestHandler = onCall(CONTEST_CONFIG, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "User must be logged in.");
    }

    const { action } = request.data;
    if (!action || !["join", "vote"].includes(action)) {
        throw new HttpsError("invalid-argument", "Invalid action. Use 'join' or 'vote'.");
    }

    if (action === "join") {
        return handleJoin(request);
    } else {
        return handleVote(request);
    }
});

// --- JOIN LOGIC ---
async function handleJoin(request: any) {
    const { contestId, mediaUrl, caption, username, displayName } = request.data;
    const userId = request.auth.uid;

    if (!contestId || !mediaUrl) {
        throw new HttpsError("invalid-argument", "Missing contestId or mediaUrl.");
    }

    try {
        const existingEntryQuery = db.collection("entries")
            .where("contestId", "==", contestId)
            .where("userId", "==", userId)
            .limit(1);
        
        const existingEntrySnap = await existingEntryQuery.get();
        if (!existingEntrySnap.empty) {
            throw new HttpsError("already-exists", "You have already joined this contest.");
        }

        const waitingQuery = db.collection("entries")
            .where("contestId", "==", contestId)
            .where("status", "==", "waiting")
            .orderBy("createdAt", "asc")
            .limit(1);

        const waitingSnap = await waitingQuery.get();
        let potentialOpponentRef = null;
        if (!waitingSnap.empty) {
            potentialOpponentRef = waitingSnap.docs[0].ref;
        }

        const result = await db.runTransaction(async (transaction) => {
            const contestRef = db.collection("contests").doc(contestId);
            const contestDoc = await transaction.get(contestRef);

            if (!contestDoc.exists) {
                throw new HttpsError("not-found", "Contest not found.");
            }

            const contestData = contestDoc.data()!;
            if (contestData.status !== "live") {
                throw new HttpsError("failed-precondition", "Contest is not live.");
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
            } else {
                const opponentId = opponentEntry.userId;
                const userRef = db.collection("users").doc(userId);
                const opponentRef = db.collection("users").doc(opponentId);
                const [userDoc, opponentDoc] = await Promise.all([
                    transaction.get(userRef),
                    transaction.get(opponentRef)
                ]);

                const entryFeePerUser = (contestData.entryFishCoins || 0) / 2;
                if ((userDoc.data()?.fishCoins || 0) < entryFeePerUser) {
                    throw new HttpsError("failed-precondition", "Insufficient Fish Coins.");
                }

                if ((opponentDoc.data()?.fishCoins || 0) < entryFeePerUser) {
                     const entryId = db.collection("entries").doc().id;
                     const newEntry = {
                        id: entryId, contestId, userId, username, userDisplayName: displayName,
                        mediaUrl, caption: caption || "", status: "waiting",
                        createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    };
                    transaction.set(db.collection("entries").doc(entryId), newEntry);
                    return { status: "waiting", message: "Joined! Waiting for an opponent (Opponent invalid)." };
                }

                transaction.update(userRef, { 
                    fishCoins: admin.firestore.FieldValue.increment(-entryFeePerUser),
                    "stats.contestsJoined": admin.firestore.FieldValue.increment(1)
                });
                transaction.update(opponentRef, { 
                    fishCoins: admin.firestore.FieldValue.increment(-entryFeePerUser),
                    "stats.contestsJoined": admin.firestore.FieldValue.increment(1)
                });

                const voteDurationDays = contestData.voteDurationDays || 1;
                const battleEndDate = admin.firestore.Timestamp.fromMillis(Date.now() + (voteDurationDays * 24 * 60 * 60 * 1000));
                const battleId = db.collection("battles").doc().id;
                const newBattle = {
                    id: battleId,
                    contestId,
                    contestName: contestData.name,
                    contestType: contestData.type || 'photo',
                    userA: { userId: opponentId, username: opponentEntry.username, displayName: opponentEntry.userDisplayName, mediaUrl: opponentEntry.mediaUrl, votes: 0 },
                    userB: { userId: userId, username: username, displayName: displayName, mediaUrl: mediaUrl, votes: 0 },
                    totalVotes: 0,
                    status: "active",
                    endDate: battleEndDate,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                };

                transaction.set(db.collection("battles").doc(battleId), newBattle);
                transaction.update(db.collection("entries").doc(opponentEntry.id), { status: "paired", battleId });

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
                    sendPushNotification(result.opponentId, "Opponent Found! ⚔️", `Your battle in ${result.contestName} has started!`, "battle_started"),
                    sendPushNotification(userId, "Battle Live! 🚀", `You are now competing in ${result.contestName}!`, "battle_started")
                ]);
            } catch (notificationError) {
                console.error("Error sending push notifications:", notificationError);
            }
        }
        
        // DYNAMIC REWARD:
        await awardReward(userId, "contest_join").catch(err => console.error("Reward Award Failed:", err));
        
        return result;

    } catch (error: any) {
        console.error("Error in joinContest:", error);
        throw new HttpsError("internal", error.message || "Something went wrong.");
    }
}

// --- VOTE LOGIC ---
async function handleVote(request: any) {
    const { battleId, participantId } = request.data;
    const voterId = request.auth.uid;

    if (!battleId || !participantId) {
        throw new HttpsError("invalid-argument", "Missing battleId or participantId.");
    }

    try {
        await db.runTransaction(async (transaction) => {
            const battleRef = db.collection("battles").doc(battleId);
            const battleDoc = await transaction.get(battleRef);

            if (!battleDoc.exists) throw new HttpsError("not-found", "Battle not found.");

            const battleData = battleDoc.data()!;
            if (battleData.status !== "active") throw new HttpsError("failed-precondition", "Battle ended.");
            if (battleData.endDate.toDate() < new Date()) throw new HttpsError("failed-precondition", "Contest expired.");

            const voteId = `${voterId}_${battleId}`;
            const voteRef = db.collection("votes").doc(voteId);
            const voteDoc = await transaction.get(voteRef);

            if (voteDoc.exists) throw new HttpsError("already-exists", "Already voted.");

            const isUserA = battleData.userA.userId === participantId;
            const isUserB = battleData.userB.userId === participantId;

            if (!isUserA && !isUserB) throw new HttpsError("invalid-argument", "Invalid participant.");

            transaction.set(voteRef, {
                id: voteId, battleId, voterId, votedFor: participantId, contestId: battleData.contestId, createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });

            const updateData: any = { totalVotes: admin.firestore.FieldValue.increment(1) };
            if (isUserA) updateData["userA.votes"] = admin.firestore.FieldValue.increment(1);
            else updateData["userB.votes"] = admin.firestore.FieldValue.increment(1);

            transaction.update(battleRef, updateData);

            const participantRef = db.collection("users").doc(participantId);
            transaction.update(participantRef, { "stats.totalVotesReceived": admin.firestore.FieldValue.increment(1) });
        });

        // DYNAMIC REWARD:
        await awardReward(voterId, "battle_vote").catch(err => console.error("Reward Award Failed:", err));
        
        return { success: true, message: "Vote recorded successfully!" };

    } catch (error: any) {
        console.error("Error in voteInBattle:", error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "Voting failed.");
    }
}
