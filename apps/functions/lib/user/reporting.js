"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.reportContent = void 0;
const https_1 = require("firebase-functions/v2/https");
const firebase_1 = require("../utils/firebase");
const firestore_1 = require("firebase-admin/firestore");
const sender_1 = require("../notifications/sender");
/**
 * PRODUCTION-GRADE REPORTING SYSTEM
 * Handles user reports for Posts, Stories, and Profiles.
 * Automatically hides content after a threshold.
 */
const reportContent = async (request) => {
    const { targetId, targetType, reason, details } = request.data;
    const reporterUid = request.auth.uid;
    if (!targetId || !targetType) {
        throw new https_1.HttpsError("invalid-argument", "Target ID and Type are required.");
    }
    const validTypes = ["posts", "stories", "users", "contestMatches"];
    if (!validTypes.includes(targetType)) {
        throw new https_1.HttpsError("invalid-argument", "Invalid target type.");
    }
    try {
        const reportId = `${targetType}_${targetId}_${reporterUid}`;
        const reportRef = firebase_1.db.collection("reports").doc(reportId);
        // 1. Check if already reported by this user
        const existingReport = await reportRef.get();
        if (existingReport.exists) {
            throw new https_1.HttpsError("already-exists", "You have already reported this content.");
        }
        // 2. Save the report
        await reportRef.set({
            targetId,
            targetType,
            reporterUid,
            reason: reason || "inappropriate",
            details: details || "",
            status: "pending",
            createdAt: firestore_1.FieldValue.serverTimestamp()
        });
        // 3. Update the target's report counter
        const targetRef = firebase_1.db.collection(targetType).doc(targetId);
        await targetRef.update({
            reportCount: firestore_1.FieldValue.increment(1)
        });
        // 4. AUTOMATED MODERATION: Threshold Check
        const targetDoc = await targetRef.get();
        const targetData = targetDoc.data();
        const reportCount = (targetData === null || targetData === void 0 ? void 0 : targetData.reportCount) || 1;
        // Auto-hide after 5 reports
        if (reportCount >= 5 && !(targetData === null || targetData === void 0 ? void 0 : targetData.isHidden)) {
            await targetRef.update({
                isHidden: true,
                autoHiddenBySystem: true,
                hiddenAt: firestore_1.FieldValue.serverTimestamp()
            });
            // Log for Admin
            console.log(`Content ${targetId} (${targetType}) auto-hidden after ${reportCount} reports.`);
            // Send notification to the owner
            const ownerId = targetType === "users" ? targetId : targetData === null || targetData === void 0 ? void 0 : targetData.userId;
            if (ownerId) {
                const contentType = targetType === "users" ? "profile" :
                    targetType === "stories" ? "story" :
                        targetType === "posts" ? "post" : "content";
                await (0, sender_1.sendPushNotification)(ownerId, "Content Hidden", `Your ${contentType} has been hidden due to multiple reports.`, "content_hidden", { targetId, targetType });
            }
        }
        return { success: true, message: "Report submitted successfully." };
    }
    catch (e) {
        if (e instanceof https_1.HttpsError)
            throw e;
        console.error("Error reporting content:", e);
        throw new https_1.HttpsError("internal", e.message);
    }
};
exports.reportContent = reportContent;
//# sourceMappingURL=reporting.js.map