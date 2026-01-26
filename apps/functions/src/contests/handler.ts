import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import { db } from "../utils/firebase";
import { FieldValue } from "firebase-admin/firestore";
import { sendPushNotification, sendBroadcastNotification } from "../notifications/sender";
import { awardXp } from "../utils/gamification";
import { createNotification } from "../notifications/utils";

const CONTEST_CONFIG = {
    region: "us-central1",
    cpu: 1,
    memory: "512MiB" as any,
    maxInstances: 10,
    cors: true
};

const generateJoinId = () => "JN-" + Math.random().toString(36).substring(2, 8).toUpperCase();

/**
 * Helper to get User IP safely from Callable Request
 */
function getClientIp(request: any): string {
    const headers = request.rawRequest?.headers;
    const xForwardedFor = headers?.['x-forwarded-for'] as string;
    if (xForwardedFor) {
        return xForwardedFor.split(',')[0].trim();
    }
    return request.rawRequest?.socket?.remoteAddress || 'unknown';
}

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
        case "createTemplate": 
        case "contest_createTemplate":
            return handleCreateTemplate(request);
        default: throw new HttpsError("invalid-argument", `Unknown action: ${action}`);
    }
});

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

            // 1. Participant Limit Check
            const maxParticipants = Number(contestData.maxParticipants || 1000000);
            const joinedCount = Number(contestData.joinedCount || 0);
            if (joinedCount >= maxParticipants) {
                throw new HttpsError("failed-precondition", "This contest is full!");
            }

            // Updated field names
            const entryFee = Number(contestData.entryFee || 0);
            const fee = Math.ceil(entryFee / 2);
            if ((userData.Dpcoin || 0) < fee) throw new HttpsError("failed-precondition", "Insufficient Dpcoins.");

            const joinIdA = generateJoinId();
            const matchRef = db.collection("contestMatches").doc();
            
            // 2. Increment joinedCount and update user
            transaction.update(contestRef, { joinedCount: FieldValue.increment(1) });
            transaction.update(userRef, { Dpcoin: FieldValue.increment(-fee), xp: FieldValue.increment(10) });
            
            const matchData = {
                id: matchRef.id, contestId, status: "waiting_for_opponent",
                type: contestData.type || 'photo', title: contestData.title || contestData.name,
                entryFee: entryFee, isPrivate: !!invitedUid, invitedUid: invitedUid || null,
                joinIdA, joinIds: [joinIdA],
                userA: { uid, joinId: joinIdA, username: userData.username, profilePic: userData.profileImageUrl || "", mediaUrl, mediaType: mediaType || 'photo', caption: caption || "", votes: 0, deviceId: deviceId || "" },
                userB: null, totalVotes: 0, likeCount: 0, commentCount: 0, shareCount: 0,
                createdAt: FieldValue.serverTimestamp(),
                expiresAt: admin.firestore.Timestamp.fromDate(new Date(Date.now() + (contestData.autoCancelHours || 24) * 3600000))
            };

            transaction.set(matchRef, matchData);
            return { matchId: matchRef.id, joinId: joinIdA, contestTitle: matchData.title };
        });
        return result;
    } catch (e: any) { 
        if (e instanceof HttpsError) throw e;
        throw new HttpsError("internal", e.message); 
    }
}

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

            const contestRef = db.collection("contests").doc(matchData.contestId);
            const contestDoc = await transaction.get(contestRef);
            if (contestDoc.exists) {
                const contestData = contestDoc.data()!;
                const maxParticipants = Number(contestData.maxParticipants || 1000000);
                const joinedCount = Number(contestData.joinedCount || 0);
                if (joinedCount >= maxParticipants) {
                    throw new HttpsError("failed-precondition", "This contest is already full!");
                }
                transaction.update(contestRef, { joinedCount: FieldValue.increment(1) });
            }

            const battleDuration = (contestDoc.exists ? contestDoc.data()?.battleDurationHours : null) || 24;
            const fee = Math.ceil(Number(matchData.entryFee || 0) / 2);
            const userData = userDoc.data()!;
            if ((userData.Dpcoin || 0) < fee) throw new HttpsError("failed-precondition", "Insufficient coins.");

            const joinIdB = generateJoinId();
            transaction.update(userRef, { Dpcoin: FieldValue.increment(-fee), xp: FieldValue.increment(10) });
            transaction.update(matchRef, {
                status: "active", joinIdB, joinIds: FieldValue.arrayUnion(joinIdB),
                userB: { uid, joinId: joinIdB, username: userData.username, profilePic: userData.profileImageUrl || "", mediaUrl, mediaType: mediaType || 'photo', caption: caption || "", votes: 0, deviceId: deviceId || "" },
                activatedAt: FieldValue.serverTimestamp(),
                endDate: admin.firestore.Timestamp.fromDate(new Date(Date.now() + battleDuration * 3600000))
            });
            return { userAId: matchData.userA.uid, matchTitle: matchData.title, joinId: joinIdB };
        });

        await sendPushNotification(result.userAId, "Opponent Found! 🔥", `Someone joined your battle in ${result.matchTitle}`, "match_active", { matchId });
        return { status: "active", joinId: result.joinId };
    } catch (e: any) { 
        if (e instanceof HttpsError) throw e;
        throw new HttpsError("internal", e.message); 
    }
}

async function handleVote(request: any) {
    const { matchId, votedForUid, deviceId } = request.data;
    const uid = request.auth.uid;
    const clientIp = getClientIp(request);

    if (uid === votedForUid) throw new HttpsError("permission-denied", "You cannot vote for yourself.");

    try {
        let voterName = "Someone";
        let targetUid = votedForUid;
        
        await db.runTransaction(async (transaction) => {
            const matchRef = db.collection("contestMatches").doc(matchId);
            const voteDocId = `${matchId}_${uid}`;
            const voteRef = db.collection("votes").doc(voteDocId);
            const deviceMatchVoteRef = db.collection("deviceMatchVotes").doc(`${matchId}_${deviceId || 'unknown'}`);
            const voterUserRef = db.collection("users").doc(uid);
            
            const [matchDoc, voteDoc, deviceMatchVoteDoc, voterDoc] = await Promise.all([
                transaction.get(matchRef),
                transaction.get(voteRef),
                deviceId ? transaction.get(deviceMatchVoteRef) : Promise.resolve(null),
                transaction.get(voterUserRef)
            ]);

            if (!matchDoc.exists) throw new HttpsError("not-found", "Match not found.");
            if (voteDoc.exists) throw new HttpsError("already-exists", "You have already voted.");

            if (voterDoc.exists) {
                voterName = voterDoc.data()?.username || voterDoc.data()?.displayName || "Someone";
            }

            const matchData = matchDoc.data()!;
            if (matchData.endDate && matchData.endDate.toDate() < new Date()) throw new HttpsError("failed-precondition", "Ended.");

            if (deviceId) {
                const deviceVoteCount = deviceMatchVoteDoc?.exists ? (deviceMatchVoteDoc.data()?.count || 0) : 0;
                if (deviceVoteCount >= 5) throw new HttpsError("resource-exhausted", "Device limit reached.");
                if (!deviceMatchVoteDoc?.exists) transaction.set(deviceMatchVoteRef, { count: 1, matchId, deviceId, updatedAt: FieldValue.serverTimestamp() });
                else transaction.update(deviceMatchVoteRef, { count: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() });
            }

            const updateKey = matchData.userA.uid === votedForUid ? "userA.votes" : "userB.votes";
            transaction.update(matchRef, { [updateKey]: FieldValue.increment(1), totalVotes: FieldValue.increment(1) });
            transaction.set(voteRef, { matchId, voterUid: uid, votedForUid, deviceId: deviceId || null, ip: clientIp, timestamp: FieldValue.serverTimestamp() });
        });

        // 1. Create In-App Notification
        await createNotification(targetUid, {
            title: "New Vote! 🗳️",
            body: `${voterName} voted for you in a battle!`,
            type: "vote" as any,
            targetId: matchId,
            image: "", // Could add match image here
            data: { matchId, voterUid: uid, voterName }
        });

        // 2. Send Push Notification
        await sendPushNotification(targetUid, "New Vote! 🗳️", `${voterName} voted for you in a battle!`, "vote", { matchId });

        await awardXp(uid, 5, "voted_in_contest");
        return { success: true };
    } catch (e: any) {
        if (e instanceof HttpsError) throw e;
        throw new HttpsError("internal", e.message); 
    }
}

async function handleLike(request: any) {
    const { matchId } = request.data;
    const uid = request.auth.uid;
    if (!matchId) throw new HttpsError("invalid-argument", "Missing matchId.");

    try {
        const likeRef = db.collection("contestMatches").doc(matchId).collection("likes").doc(uid);
        const matchRef = db.collection("contestMatches").doc(matchId);
        
        const likeDoc = await likeRef.get();
        if (likeDoc.exists) {
            await likeRef.delete();
            await matchRef.update({ likeCount: FieldValue.increment(-1) });
            return { liked: false };
        } else {
            await likeRef.set({ uid, timestamp: FieldValue.serverTimestamp() });
            await matchRef.update({ likeCount: FieldValue.increment(1) });
            return { liked: true };
        }
    } catch (e: any) { throw new HttpsError("internal", e.message); }
}

async function handleComment(request: any) { 
    const { matchId } = request.data;
    if (!matchId) throw new HttpsError("invalid-argument", "Missing matchId.");
    return { success: true }; 
}

async function handleShare(request: any) {
    const { matchId } = request.data;
    if (!matchId) throw new HttpsError("invalid-argument", "Missing matchId.");
    try {
        await db.collection("contestMatches").doc(matchId).update({ shareCount: FieldValue.increment(1) });
        return { success: true };
    } catch (e: any) { throw new HttpsError("internal", e.message); }
}

async function handleJoin(request: any) { return { success: true }; }

async function handleCreateTemplate(request: any) {
    const user = await db.collection("users").doc(request.auth.uid).get();
    if (user.data()?.role !== "admin") throw new HttpsError("permission-denied", "Admin only.");
    
    const id = db.collection("contests").doc().id;
    const contestData = { ...request.data };
    delete contestData.action;

    const templateDuration = Number(contestData.templateDurationHours || 48);

    await db.collection("contests").doc(id).set({ 
        ...contestData, 
        id, 
        status: "live", 
        joinedCount: 0,
        createdAt: FieldValue.serverTimestamp(),
        expiresAt: admin.firestore.Timestamp.fromDate(new Date(Date.now() + templateDuration * 3600000))
    });

    await sendBroadcastNotification(
        "New Contest is Live! 🏆", 
        `Join the new ${contestData.title || 'Contest'} and win big prizes!`,
        { type: "new_contest", contestId: id }
    );

    return { success: true, id };
}
