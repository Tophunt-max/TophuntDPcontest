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
const firestore_1 = require("firebase-admin/firestore");
const sender_1 = require("../notifications/sender");
const gamification_1 = require("../utils/gamification");
const CONTEST_CONFIG = {
    region: "us-central1",
    cpu: 1,
    memory: "512MiB",
    maxInstances: 10,
    cors: true
};
// Helper for Join IDs
const generateJoinId = () => "JN-" + Math.random().toString(36).substring(2, 8).toUpperCase();
/**
 * MASTER CONTEST HANDLER
 */
exports.contestHandler = (0, https_1.onCall)(CONTEST_CONFIG, async (request) => {
    if (!request.auth)
        throw new https_1.HttpsError("unauthenticated", "User must be logged in.");
    const { action } = request.data;
    if (!action)
        throw new https_1.HttpsError("invalid-argument", "Action is required.");
    switch (action) {
        case "join": return handleJoin(request);
        case "vote": return handleVote(request);
        case "like": return handleLike(request);
        case "comment": return handleComment(request);
        case "share": return handleShare(request);
        case "startMatch": return handleStartMatch(request);
        case "joinMatch": return handleJoinMatch(request);
        case "createTemplate": return handleCreateTemplate(request);
        default: throw new https_1.HttpsError("invalid-argument", `Unknown action: ${action}`);
    }
});
/** 1. START MATCH (User A) **/
async function handleStartMatch(request) {
    const { contestId, mediaUrl, mediaType, caption, deviceId, invitedUid } = request.data;
    const uid = request.auth.uid;
    if (!contestId || !mediaUrl)
        throw new https_1.HttpsError("invalid-argument", "Missing contestId or mediaUrl.");
    try {
        const result = await firebase_1.db.runTransaction(async (transaction) => {
            const contestRef = firebase_1.db.collection("contests").doc(contestId);
            const userRef = firebase_1.db.collection("users").doc(uid);
            const [contestDoc, userDoc] = await Promise.all([transaction.get(contestRef), transaction.get(userRef)]);
            if (!contestDoc.exists)
                throw new https_1.HttpsError("not-found", "Contest not found.");
            const contestData = contestDoc.data();
            const userData = userDoc.data();
            const totalFee = Number(contestData.totalEntryFee || 0);
            const fee = Math.ceil(totalFee / 2);
            if ((userData.Dpcoin || 0) < fee)
                throw new https_1.HttpsError("failed-precondition", "Insufficient Dpcoins.");
            const joinIdA = generateJoinId();
            const matchRef = firebase_1.db.collection("contestMatches").doc();
            transaction.update(userRef, { Dpcoin: firestore_1.FieldValue.increment(-fee), xp: firestore_1.FieldValue.increment(10) });
            const matchData = {
                id: matchRef.id, contestId, status: "waiting_for_opponent",
                type: contestData.type || 'photo', title: contestData.title || contestData.name,
                entryFee: totalFee, isPrivate: !!invitedUid, invitedUid: invitedUid || null,
                joinIdA, joinIds: [joinIdA],
                userA: { uid, joinId: joinIdA, username: userData.username, profilePic: userData.profileImageUrl || "", mediaUrl, mediaType: mediaType || 'photo', caption: caption || "", votes: 0, deviceId: deviceId || "" },
                userB: null, totalVotes: 0, likeCount: 0, commentCount: 0, shareCount: 0,
                createdAt: firestore_1.FieldValue.serverTimestamp(),
                expiresAt: admin.firestore.Timestamp.fromDate(new Date(Date.now() + (contestData.autoCancelHours || 24) * 3600000))
            };
            transaction.set(matchRef, matchData);
            return { matchId: matchRef.id, joinId: joinIdA, contestTitle: matchData.title };
        });
        // Auto-story logic
        await firebase_1.db.collection("stories").add({ userId: uid, username: request.data.username || "User", type: 'contest_announcement', matchId: result.matchId, createdAt: firestore_1.FieldValue.serverTimestamp(), expiresAt: admin.firestore.Timestamp.fromDate(new Date(Date.now() + 86400000)) }).catch(() => { });
        return result;
    }
    catch (e) {
        throw new https_1.HttpsError("internal", e.message);
    }
}
/** 2. JOIN MATCH (User B) **/
async function handleJoinMatch(request) {
    const { matchId, mediaUrl, mediaType, caption, deviceId } = request.data;
    const uid = request.auth.uid;
    try {
        const result = await firebase_1.db.runTransaction(async (transaction) => {
            const matchRef = firebase_1.db.collection("contestMatches").doc(matchId);
            const userRef = firebase_1.db.collection("users").doc(uid);
            const [matchDoc, userDoc] = await Promise.all([transaction.get(matchRef), transaction.get(userRef)]);
            if (!matchDoc.exists)
                throw new https_1.HttpsError("not-found", "Match not found.");
            const matchData = matchDoc.data();
            if (matchData.status !== "waiting_for_opponent")
                throw new https_1.HttpsError("failed-precondition", "Match full.");
            if (matchData.userA.uid === uid)
                throw new https_1.HttpsError("failed-precondition", "Cannot join own match.");
            const fee = Math.ceil(Number(matchData.entryFee || 0) / 2);
            const userData = userDoc.data();
            if ((userData.Dpcoin || 0) < fee)
                throw new https_1.HttpsError("failed-precondition", "Insufficient coins.");
            const joinIdB = generateJoinId();
            transaction.update(userRef, { Dpcoin: firestore_1.FieldValue.increment(-fee), xp: firestore_1.FieldValue.increment(10) });
            transaction.update(matchRef, {
                status: "active", joinIdB, joinIds: firestore_1.FieldValue.arrayUnion(joinIdB),
                userB: { uid, joinId: joinIdB, username: userData.username, profilePic: userData.profileImageUrl || "", mediaUrl, mediaType: mediaType || 'photo', caption: caption || "", votes: 0, deviceId: deviceId || "" },
                activatedAt: firestore_1.FieldValue.serverTimestamp(),
            });
            return { userAId: matchData.userA.uid, matchTitle: matchData.title, joinId: joinIdB };
        });
        await (0, sender_1.sendPushNotification)(result.userAId, "Match Live! 🚀", `Someone joined your battle in ${result.matchTitle}`, "match_active", { matchId });
        return { status: "active", joinId: result.joinId };
    }
    catch (e) {
        throw new https_1.HttpsError("internal", e.message);
    }
}
/** 3. VOTE **/
async function handleVote(request) {
    const { matchId, votedForUid, deviceId } = request.data;
    const uid = request.auth.uid;
    if (!matchId || !votedForUid)
        throw new https_1.HttpsError("invalid-argument", "Missing data.");
    try {
        await firebase_1.db.runTransaction(async (transaction) => {
            const matchRef = firebase_1.db.collection("contestMatches").doc(matchId);
            const voteRef = firebase_1.db.collection("votes").doc(`${matchId}_${uid}`);
            const [matchDoc, voteDoc] = await Promise.all([transaction.get(matchRef), transaction.get(voteRef)]);
            if (!matchDoc.exists || voteDoc.exists)
                throw new https_1.HttpsError("failed-precondition", "Cannot vote.");
            const matchData = matchDoc.data();
            const updateKey = matchData.userA.uid === votedForUid ? "userA.votes" : "userB.votes";
            transaction.update(matchRef, { [updateKey]: firestore_1.FieldValue.increment(1), totalVotes: firestore_1.FieldValue.increment(1) });
            transaction.set(voteRef, { matchId, voterUid: uid, votedForUid, deviceId, timestamp: firestore_1.FieldValue.serverTimestamp() });
        });
        await (0, gamification_1.awardXp)(uid, 5, "voted_in_contest");
        return { success: true, message: "Vote recorded!" };
    }
    catch (e) {
        throw new https_1.HttpsError("internal", e.message);
    }
}
/** 4. LIKE/COMMENT (Engagement) **/
async function handleLike(request) {
    const { matchId } = request.data;
    const uid = request.auth.uid;
    const matchRef = firebase_1.db.collection("contestMatches").doc(matchId);
    const likeRef = matchRef.collection("likes").doc(uid);
    const doc = await likeRef.get();
    if (doc.exists) {
        await matchRef.update({ likeCount: firestore_1.FieldValue.increment(-1) });
        await likeRef.delete();
        return { action: "unliked" };
    }
    else {
        await matchRef.update({ likeCount: firestore_1.FieldValue.increment(1) });
        await likeRef.set({ userId: uid, timestamp: firestore_1.FieldValue.serverTimestamp() });
        return { action: "liked" };
    }
}
async function handleComment(request) {
    const { matchId, text } = request.data;
    const uid = request.auth.uid;
    const matchRef = firebase_1.db.collection("contestMatches").doc(matchId);
    await matchRef.update({ commentCount: firestore_1.FieldValue.increment(1) });
    await matchRef.collection("comments").add({ userId: uid, text, timestamp: firestore_1.FieldValue.serverTimestamp() });
    return { success: true };
}
async function handleShare(request) {
    await firebase_1.db.collection("contestMatches").doc(request.data.matchId).update({ shareCount: firestore_1.FieldValue.increment(1) });
    return { success: true };
}
async function handleJoin(request) {
    // Legacy logic to keep compatibility
    return { status: "waiting", message: "Joined successfully." };
}
async function handleCreateTemplate(request) {
    var _a;
    const user = await firebase_1.db.collection("users").doc(request.auth.uid).get();
    if (((_a = user.data()) === null || _a === void 0 ? void 0 : _a.role) !== "admin")
        throw new https_1.HttpsError("permission-denied", "Admin only.");
    const id = firebase_1.db.collection("contests").doc().id;
    await firebase_1.db.collection("contests").doc(id).set(Object.assign(Object.assign({}, request.data), { id, status: "live", createdAt: firestore_1.FieldValue.serverTimestamp() }));
    return { success: true, id };
}
//# sourceMappingURL=handler.js.map