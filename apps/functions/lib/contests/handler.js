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
const utils_1 = require("../notifications/utils");
const CONTEST_CONFIG = {
    region: "us-central1",
    cpu: 1,
    memory: "512MiB",
    maxInstances: 10,
    cors: true
};
const generateJoinId = () => "JN-" + Math.random().toString(36).substring(2, 8).toUpperCase();
/**
 * Helper to get User IP safely from Callable Request
 */
function getClientIp(request) {
    var _a, _b, _c;
    const headers = (_a = request.rawRequest) === null || _a === void 0 ? void 0 : _a.headers;
    const xForwardedFor = headers === null || headers === void 0 ? void 0 : headers['x-forwarded-for'];
    if (xForwardedFor) {
        return xForwardedFor.split(',')[0].trim();
    }
    return ((_c = (_b = request.rawRequest) === null || _b === void 0 ? void 0 : _b.socket) === null || _c === void 0 ? void 0 : _c.remoteAddress) || 'unknown';
}
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
        case "createTemplate":
        case "contest_createTemplate":
            return handleCreateTemplate(request);
        default: throw new https_1.HttpsError("invalid-argument", `Unknown action: ${action}`);
    }
});
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
            // 1. Participant Limit Check
            const maxParticipants = Number(contestData.maxParticipants || 1000000);
            const joinedCount = Number(contestData.joinedCount || 0);
            if (joinedCount >= maxParticipants) {
                throw new https_1.HttpsError("failed-precondition", "This contest is full!");
            }
            // Updated field names
            const entryFee = Number(contestData.entryFee || 0);
            const fee = Math.ceil(entryFee / 2);
            if ((userData.Dpcoin || 0) < fee)
                throw new https_1.HttpsError("failed-precondition", "Insufficient Dpcoins.");
            const joinIdA = generateJoinId();
            const matchRef = firebase_1.db.collection("contestMatches").doc();
            // 2. Increment joinedCount and update user
            transaction.update(contestRef, { joinedCount: firestore_1.FieldValue.increment(1) });
            transaction.update(userRef, { Dpcoin: firestore_1.FieldValue.increment(-fee), xp: firestore_1.FieldValue.increment(10) });
            const matchData = {
                id: matchRef.id, contestId, status: "waiting_for_opponent",
                type: contestData.type || 'photo', title: contestData.title || contestData.name,
                entryFee: entryFee, isPrivate: !!invitedUid, invitedUid: invitedUid || null,
                joinIdA, joinIds: [joinIdA],
                userA: { uid, joinId: joinIdA, username: userData.username, profilePic: userData.profileImageUrl || "", mediaUrl, mediaType: mediaType || 'photo', caption: caption || "", votes: 0, deviceId: deviceId || "" },
                userB: null, totalVotes: 0, likeCount: 0, commentCount: 0, shareCount: 0,
                createdAt: firestore_1.FieldValue.serverTimestamp(),
                expiresAt: admin.firestore.Timestamp.fromDate(new Date(Date.now() + (contestData.autoCancelHours || 24) * 3600000))
            };
            transaction.set(matchRef, matchData);
            return { matchId: matchRef.id, joinId: joinIdA, contestTitle: matchData.title };
        });
        return result;
    }
    catch (e) {
        if (e instanceof https_1.HttpsError)
            throw e;
        throw new https_1.HttpsError("internal", e.message);
    }
}
async function handleJoinMatch(request) {
    const { matchId, mediaUrl, mediaType, caption, deviceId } = request.data;
    const uid = request.auth.uid;
    try {
        const result = await firebase_1.db.runTransaction(async (transaction) => {
            var _a;
            const matchRef = firebase_1.db.collection("contestMatches").doc(matchId);
            const userRef = firebase_1.db.collection("users").doc(uid);
            const [matchDoc, userDoc] = await Promise.all([transaction.get(matchRef), transaction.get(userRef)]);
            if (!matchDoc.exists)
                throw new https_1.HttpsError("not-found", "Match not found.");
            const matchData = matchDoc.data();
            if (matchData.status !== "waiting_for_opponent")
                throw new https_1.HttpsError("failed-precondition", "Match full.");
            const contestRef = firebase_1.db.collection("contests").doc(matchData.contestId);
            const contestDoc = await transaction.get(contestRef);
            if (contestDoc.exists) {
                const contestData = contestDoc.data();
                const maxParticipants = Number(contestData.maxParticipants || 1000000);
                const joinedCount = Number(contestData.joinedCount || 0);
                if (joinedCount >= maxParticipants) {
                    throw new https_1.HttpsError("failed-precondition", "This contest is already full!");
                }
                transaction.update(contestRef, { joinedCount: firestore_1.FieldValue.increment(1) });
            }
            const battleDuration = (contestDoc.exists ? (_a = contestDoc.data()) === null || _a === void 0 ? void 0 : _a.battleDurationHours : null) || 24;
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
                endDate: admin.firestore.Timestamp.fromDate(new Date(Date.now() + battleDuration * 3600000))
            });
            return { userAId: matchData.userA.uid, matchTitle: matchData.title, joinId: joinIdB };
        });
        await (0, sender_1.sendPushNotification)(result.userAId, "Opponent Found! 🔥", `Someone joined your battle in ${result.matchTitle}`, "match_active", { matchId });
        return { status: "active", joinId: result.joinId };
    }
    catch (e) {
        if (e instanceof https_1.HttpsError)
            throw e;
        throw new https_1.HttpsError("internal", e.message);
    }
}
async function handleVote(request) {
    const { matchId, votedForUid, deviceId } = request.data;
    const uid = request.auth.uid;
    const clientIp = getClientIp(request);
    if (uid === votedForUid)
        throw new https_1.HttpsError("permission-denied", "You cannot vote for yourself.");
    try {
        let voterName = "Someone";
        let targetUid = votedForUid;
        await firebase_1.db.runTransaction(async (transaction) => {
            var _a, _b, _c;
            const matchRef = firebase_1.db.collection("contestMatches").doc(matchId);
            const voteDocId = `${matchId}_${uid}`;
            const voteRef = firebase_1.db.collection("votes").doc(voteDocId);
            const deviceMatchVoteRef = firebase_1.db.collection("deviceMatchVotes").doc(`${matchId}_${deviceId || 'unknown'}`);
            const voterUserRef = firebase_1.db.collection("users").doc(uid);
            const [matchDoc, voteDoc, deviceMatchVoteDoc, voterDoc] = await Promise.all([
                transaction.get(matchRef),
                transaction.get(voteRef),
                deviceId ? transaction.get(deviceMatchVoteRef) : Promise.resolve(null),
                transaction.get(voterUserRef)
            ]);
            if (!matchDoc.exists)
                throw new https_1.HttpsError("not-found", "Match not found.");
            if (voteDoc.exists)
                throw new https_1.HttpsError("already-exists", "You have already voted.");
            if (voterDoc.exists) {
                voterName = ((_a = voterDoc.data()) === null || _a === void 0 ? void 0 : _a.username) || ((_b = voterDoc.data()) === null || _b === void 0 ? void 0 : _b.displayName) || "Someone";
            }
            const matchData = matchDoc.data();
            if (matchData.endDate && matchData.endDate.toDate() < new Date())
                throw new https_1.HttpsError("failed-precondition", "Ended.");
            if (deviceId) {
                const deviceVoteCount = (deviceMatchVoteDoc === null || deviceMatchVoteDoc === void 0 ? void 0 : deviceMatchVoteDoc.exists) ? (((_c = deviceMatchVoteDoc.data()) === null || _c === void 0 ? void 0 : _c.count) || 0) : 0;
                if (deviceVoteCount >= 5)
                    throw new https_1.HttpsError("resource-exhausted", "Device limit reached.");
                if (!(deviceMatchVoteDoc === null || deviceMatchVoteDoc === void 0 ? void 0 : deviceMatchVoteDoc.exists))
                    transaction.set(deviceMatchVoteRef, { count: 1, matchId, deviceId, updatedAt: firestore_1.FieldValue.serverTimestamp() });
                else
                    transaction.update(deviceMatchVoteRef, { count: firestore_1.FieldValue.increment(1), updatedAt: firestore_1.FieldValue.serverTimestamp() });
            }
            const updateKey = matchData.userA.uid === votedForUid ? "userA.votes" : "userB.votes";
            transaction.update(matchRef, { [updateKey]: firestore_1.FieldValue.increment(1), totalVotes: firestore_1.FieldValue.increment(1) });
            transaction.set(voteRef, { matchId, voterUid: uid, votedForUid, deviceId: deviceId || null, ip: clientIp, timestamp: firestore_1.FieldValue.serverTimestamp() });
        });
        // 1. Create In-App Notification
        await (0, utils_1.createNotification)(targetUid, {
            title: "New Vote! 🗳️",
            body: `${voterName} voted for you in a battle!`,
            type: "vote",
            targetId: matchId,
            image: "", // Could add match image here
            data: { matchId, voterUid: uid, voterName }
        });
        // 2. Send Push Notification
        await (0, sender_1.sendPushNotification)(targetUid, "New Vote! 🗳️", `${voterName} voted for you in a battle!`, "vote", { matchId });
        await (0, gamification_1.awardXp)(uid, 5, "voted_in_contest");
        return { success: true };
    }
    catch (e) {
        if (e instanceof https_1.HttpsError)
            throw e;
        throw new https_1.HttpsError("internal", e.message);
    }
}
async function handleLike(request) {
    const { matchId } = request.data;
    const uid = request.auth.uid;
    if (!matchId)
        throw new https_1.HttpsError("invalid-argument", "Missing matchId.");
    try {
        const likeRef = firebase_1.db.collection("contestMatches").doc(matchId).collection("likes").doc(uid);
        const matchRef = firebase_1.db.collection("contestMatches").doc(matchId);
        const likeDoc = await likeRef.get();
        if (likeDoc.exists) {
            await likeRef.delete();
            await matchRef.update({ likeCount: firestore_1.FieldValue.increment(-1) });
            return { liked: false };
        }
        else {
            await likeRef.set({ uid, timestamp: firestore_1.FieldValue.serverTimestamp() });
            await matchRef.update({ likeCount: firestore_1.FieldValue.increment(1) });
            return { liked: true };
        }
    }
    catch (e) {
        throw new https_1.HttpsError("internal", e.message);
    }
}
async function handleComment(request) {
    const { matchId } = request.data;
    if (!matchId)
        throw new https_1.HttpsError("invalid-argument", "Missing matchId.");
    return { success: true };
}
async function handleShare(request) {
    const { matchId } = request.data;
    if (!matchId)
        throw new https_1.HttpsError("invalid-argument", "Missing matchId.");
    try {
        await firebase_1.db.collection("contestMatches").doc(matchId).update({ shareCount: firestore_1.FieldValue.increment(1) });
        return { success: true };
    }
    catch (e) {
        throw new https_1.HttpsError("internal", e.message);
    }
}
async function handleJoin(request) { return { success: true }; }
async function handleCreateTemplate(request) {
    var _a;
    const user = await firebase_1.db.collection("users").doc(request.auth.uid).get();
    if (((_a = user.data()) === null || _a === void 0 ? void 0 : _a.role) !== "admin")
        throw new https_1.HttpsError("permission-denied", "Admin only.");
    const id = firebase_1.db.collection("contests").doc().id;
    const contestData = Object.assign({}, request.data);
    delete contestData.action;
    const templateDuration = Number(contestData.templateDurationHours || 48);
    await firebase_1.db.collection("contests").doc(id).set(Object.assign(Object.assign({}, contestData), { id, status: "live", joinedCount: 0, createdAt: firestore_1.FieldValue.serverTimestamp(), expiresAt: admin.firestore.Timestamp.fromDate(new Date(Date.now() + templateDuration * 3600000)) }));
    await (0, sender_1.sendBroadcastNotification)("New Contest is Live! 🏆", `Join the new ${contestData.title || 'Contest'} and win big prizes!`, { type: "new_contest", contestId: id });
    return { success: true, id };
}
//# sourceMappingURL=handler.js.map