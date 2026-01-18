import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import { db } from "../utils/firebase";
import { FieldValue } from "firebase-admin/firestore";
import { sendPushNotification } from "../notifications/sender";
import { awardXp } from "../utils/gamification";

const CONTEST_CONFIG = {
    region: "us-central1",
    cpu: 1,
    memory: "512MiB" as any,
    maxInstances: 10,
    cors: true
};

// Helper for Join IDs
const generateJoinId = () => "JN-" + Math.random().toString(36).substring(2, 8).toUpperCase();

/**
 * MASTER CONTEST HANDLER
 */
export const contestHandler = onCall(CONTEST_CONFIG, async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "User must be logged in.");
    const { action } = request.data;
    if (!action) throw new HttpsError("invalid-argument", "Action is required.");

    switch (action) {
        case "join": return handleJoin(request);
        case "vote": return handleVote(request);
        case "like": return handleLike(request);
        case "comment": return handleComment(request);
        case "share": return handleShare(request);
        case "startMatch": return handleStartMatch(request);
        case "joinMatch": return handleJoinMatch(request);
        case "createTemplate": return handleCreateTemplate(request);
        default: throw new HttpsError("invalid-argument", `Unknown action: ${action}`);
    }
});

/** 1. START MATCH (User A) **/
async function handleStartMatch(request: any) {
    const { contestId, mediaUrl, mediaType, caption, deviceId, invitedUid } = request.data;
    const uid = request.auth.uid;
    if (!contestId || !mediaUrl) throw new HttpsError("invalid-argument", "Missing contestId or mediaUrl.");

    try {
        const result = await db.runTransaction(async (transaction) => {
            const contestRef = db.collection("contests").doc(contestId);
            const userRef = db.collection("users").doc(uid);
            const [contestDoc, userDoc] = await Promise.all([transaction.get(contestRef), transaction.get(userRef)]);

            if (!contestDoc.exists) throw new HttpsError("not-found", "Contest not found.");
            const contestData = contestDoc.data()!;
            const userData = userDoc.data()!;

            const totalFee = Number(contestData.totalEntryFee || 0);
            const fee = Math.ceil(totalFee / 2);
            if ((userData.Dpcoin || 0) < fee) throw new HttpsError("failed-precondition", "Insufficient Dpcoins.");

            const joinIdA = generateJoinId();
            const matchRef = db.collection("contestMatches").doc();
            
            transaction.update(userRef, { Dpcoin: FieldValue.increment(-fee), xp: FieldValue.increment(10) });
            
            const matchData = {
                id: matchRef.id, contestId, status: "waiting_for_opponent",
                type: contestData.type || 'photo', title: contestData.title || contestData.name,
                entryFee: totalFee, isPrivate: !!invitedUid, invitedUid: invitedUid || null,
                joinIdA, joinIds: [joinIdA],
                userA: { uid, joinId: joinIdA, username: userData.username, profilePic: userData.profileImageUrl || "", mediaUrl, mediaType: mediaType || 'photo', caption: caption || "", votes: 0, deviceId: deviceId || "" },
                userB: null, totalVotes: 0, likeCount: 0, commentCount: 0, shareCount: 0,
                createdAt: FieldValue.serverTimestamp(),
                expiresAt: admin.firestore.Timestamp.fromDate(new Date(Date.now() + (contestData.autoCancelHours || 24) * 3600000))
            };

            transaction.set(matchRef, matchData);
            return { matchId: matchRef.id, joinId: joinIdA, contestTitle: matchData.title };
        });

        // Auto-story logic
        await db.collection("stories").add({ userId: uid, username: request.data.username || "User", type: 'contest_announcement', matchId: result.matchId, createdAt: FieldValue.serverTimestamp(), expiresAt: admin.firestore.Timestamp.fromDate(new Date(Date.now() + 86400000)) }).catch(() => {});

        return result;
    } catch (e: any) { throw new HttpsError("internal", e.message); }
}

/** 2. JOIN MATCH (User B) **/
async function handleJoinMatch(request: any) {
    const { matchId, mediaUrl, mediaType, caption, deviceId } = request.data;
    const uid = request.auth.uid;

    try {
        const result = await db.runTransaction(async (transaction) => {
            const matchRef = db.collection("contestMatches").doc(matchId);
            const userRef = db.collection("users").doc(uid);
            const [matchDoc, userDoc] = await Promise.all([transaction.get(matchRef), transaction.get(userRef)]);

            if (!matchDoc.exists) throw new HttpsError("not-found", "Match not found.");
            const matchData = matchDoc.data()!;
            if (matchData.status !== "waiting_for_opponent") throw new HttpsError("failed-precondition", "Match full.");
            if (matchData.userA.uid === uid) throw new HttpsError("failed-precondition", "Cannot join own match.");

            const fee = Math.ceil(Number(matchData.entryFee || 0) / 2);
            const userData = userDoc.data()!;
            if ((userData.Dpcoin || 0) < fee) throw new HttpsError("failed-precondition", "Insufficient coins.");

            const joinIdB = generateJoinId();
            transaction.update(userRef, { Dpcoin: FieldValue.increment(-fee), xp: FieldValue.increment(10) });
            transaction.update(matchRef, {
                status: "active", joinIdB, joinIds: FieldValue.arrayUnion(joinIdB),
                userB: { uid, joinId: joinIdB, username: userData.username, profilePic: userData.profileImageUrl || "", mediaUrl, mediaType: mediaType || 'photo', caption: caption || "", votes: 0, deviceId: deviceId || "" },
                activatedAt: FieldValue.serverTimestamp(),
            });
            return { userAId: matchData.userA.uid, matchTitle: matchData.title, joinId: joinIdB };
        });

        await sendPushNotification(result.userAId, "Match Live! 🚀", `Someone joined your battle in ${result.matchTitle}`, "match_active", { matchId });
        return { status: "active", joinId: result.joinId };
    } catch (e: any) { throw new HttpsError("internal", e.message); }
}

/** 3. VOTE **/
async function handleVote(request: any) {
    const { matchId, votedForUid, deviceId } = request.data;
    const uid = request.auth.uid;
    if (!matchId || !votedForUid) throw new HttpsError("invalid-argument", "Missing data.");

    try {
        await db.runTransaction(async (transaction) => {
            const matchRef = db.collection("contestMatches").doc(matchId);
            const voteRef = db.collection("votes").doc(`${matchId}_${uid}`);
            const [matchDoc, voteDoc] = await Promise.all([transaction.get(matchRef), transaction.get(voteRef)]);

            if (!matchDoc.exists || voteDoc.exists) throw new HttpsError("failed-precondition", "Cannot vote.");
            const matchData = matchDoc.data()!;
            const updateKey = matchData.userA.uid === votedForUid ? "userA.votes" : "userB.votes";

            transaction.update(matchRef, { [updateKey]: FieldValue.increment(1), totalVotes: FieldValue.increment(1) });
            transaction.set(voteRef, { matchId, voterUid: uid, votedForUid, deviceId, timestamp: FieldValue.serverTimestamp() });
        });
        await awardXp(uid, 5, "voted_in_contest");
        return { success: true, message: "Vote recorded!" };
    } catch (e: any) { throw new HttpsError("internal", e.message); }
}

/** 4. LIKE/COMMENT (Engagement) **/
async function handleLike(request: any) {
    const { matchId } = request.data;
    const uid = request.auth.uid;
    const matchRef = db.collection("contestMatches").doc(matchId);
    const likeRef = matchRef.collection("likes").doc(uid);
    const doc = await likeRef.get();
    if (doc.exists) {
        await matchRef.update({ likeCount: FieldValue.increment(-1) });
        await likeRef.delete();
        return { action: "unliked" };
    } else {
        await matchRef.update({ likeCount: FieldValue.increment(1) });
        await likeRef.set({ userId: uid, timestamp: FieldValue.serverTimestamp() });
        return { action: "liked" };
    }
}

async function handleComment(request: any) {
    const { matchId, text } = request.data;
    const uid = request.auth.uid;
    const matchRef = db.collection("contestMatches").doc(matchId);
    await matchRef.update({ commentCount: FieldValue.increment(1) });
    await matchRef.collection("comments").add({ userId: uid, text, timestamp: FieldValue.serverTimestamp() });
    return { success: true };
}

async function handleShare(request: any) {
    await db.collection("contestMatches").doc(request.data.matchId).update({ shareCount: FieldValue.increment(1) });
    return { success: true };
}

async function handleJoin(request: any) {
    // Legacy logic to keep compatibility
    return { status: "waiting", message: "Joined successfully." };
}

async function handleCreateTemplate(request: any) {
    const user = await db.collection("users").doc(request.auth.uid).get();
    if (user.data()?.role !== "admin") throw new HttpsError("permission-denied", "Admin only.");
    const id = db.collection("contests").doc().id;
    await db.collection("contests").doc(id).set({ ...request.data, id, status: "live", createdAt: FieldValue.serverTimestamp() });
    return { success: true, id };
}
