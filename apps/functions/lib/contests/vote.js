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
exports.voteInBattle = void 0;
const https_1 = require("firebase-functions/v2/https");
const admin = __importStar(require("firebase-admin"));
/**
 * Vote for a participant in a VS battle.
 * Enforces one vote per user per battle.
 */
exports.voteInBattle = (0, https_1.onCall)(async (request) => {
    if (!request.auth) {
        throw new https_1.HttpsError("unauthenticated", "User must be logged in.");
    }
    const { battleId, participantId } = request.data;
    const voterId = request.auth.uid;
    if (!battleId || !participantId) {
        throw new https_1.HttpsError("invalid-argument", "Missing battleId or participantId.");
    }
    const db = admin.firestore();
    try {
        return await db.runTransaction(async (transaction) => {
            const battleRef = db.collection("battles").doc(battleId);
            const battleDoc = await transaction.get(battleRef);
            if (!battleDoc.exists) {
                throw new https_1.HttpsError("not-found", "Battle not found.");
            }
            const battleData = battleDoc.data();
            if (battleData.status !== "active") {
                throw new https_1.HttpsError("failed-precondition", "This battle has already ended.");
            }
            // Check if contest is still live
            if (battleData.endDate.toDate() < new Date()) {
                throw new https_1.HttpsError("failed-precondition", "The contest for this battle has expired.");
            }
            // 1. Check if user already voted in this battle
            // Unique ID format: voterId_battleId
            const voteId = `${voterId}_${battleId}`;
            const voteRef = db.collection("votes").doc(voteId);
            const voteDoc = await transaction.get(voteRef);
            if (voteDoc.exists) {
                throw new https_1.HttpsError("already-exists", "You have already voted in this battle.");
            }
            // 2. Identify which side user voted for
            const isUserA = battleData.userA.userId === participantId;
            const isUserB = battleData.userB.userId === participantId;
            if (!isUserA && !isUserB) {
                throw new https_1.HttpsError("invalid-argument", "Invalid participant selected.");
            }
            // 3. Record the vote
            transaction.set(voteRef, {
                id: voteId,
                battleId,
                voterId,
                votedFor: participantId,
                contestId: battleData.contestId,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            // 4. Update Vote Counts in Battle Document
            const updateData = {
                totalVotes: admin.firestore.FieldValue.increment(1),
            };
            if (isUserA) {
                updateData["userA.votes"] = admin.firestore.FieldValue.increment(1);
            }
            else {
                updateData["userB.votes"] = admin.firestore.FieldValue.increment(1);
            }
            transaction.update(battleRef, updateData);
            // 5. Update User's Stats (totalVotesReceived for the participant)
            const participantRef = db.collection("users").doc(participantId);
            transaction.update(participantRef, {
                "stats.totalVotesReceived": admin.firestore.FieldValue.increment(1)
            });
            return { success: true, message: "Vote recorded successfully!" };
        });
    }
    catch (error) {
        console.error("Error in voteInBattle:", error);
        if (error instanceof https_1.HttpsError)
            throw error;
        throw new https_1.HttpsError("internal", "Something went wrong while voting.");
    }
});
//# sourceMappingURL=vote.js.map