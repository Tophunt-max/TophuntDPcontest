import { HttpsError } from "firebase-functions/v2/https";
import { db } from "../utils/firebase";
import { FieldValue } from "firebase-admin/firestore";
import { sendPushNotification } from "../notifications/sender";

/**
 * PRODUCTION-GRADE REPORTING SYSTEM
 * Handles user reports for Posts, Stories, and Profiles.
 * Automatically hides content after a threshold.
 */
export const reportContent = async (request: any) => {
    const { targetId, targetType, reason, details } = request.data;
    const reporterUid = request.auth.uid;

    if (!targetId || !targetType) {
        throw new HttpsError("invalid-argument", "Target ID and Type are required.");
    }

    const validTypes = ["posts", "stories", "users", "contestMatches"];
    if (!validTypes.includes(targetType)) {
        throw new HttpsError("invalid-argument", "Invalid target type.");
    }

    try {
        const reportId = `${targetType}_${targetId}_${reporterUid}`;
        const reportRef = db.collection("reports").doc(reportId);

        // 1. Check if already reported by this user
        const existingReport = await reportRef.get();
        if (existingReport.exists) {
            throw new HttpsError("already-exists", "You have already reported this content.");
        }

        // 2. Save the report
        await reportRef.set({
            targetId,
            targetType,
            reporterUid,
            reason: reason || "inappropriate",
            details: details || "",
            status: "pending",
            createdAt: FieldValue.serverTimestamp()
        });

        // 3. Update the target's report counter
        const targetRef = db.collection(targetType).doc(targetId);
        await targetRef.update({
            reportCount: FieldValue.increment(1)
        });

        // 4. AUTOMATED MODERATION: Threshold Check
        const targetDoc = await targetRef.get();
        const targetData = targetDoc.data();
        const reportCount = targetData?.reportCount || 1;

        // Auto-hide after 5 reports
        if (reportCount >= 5 && !targetData?.isHidden) {
            await targetRef.update({ 
                isHidden: true,
                autoHiddenBySystem: true,
                hiddenAt: FieldValue.serverTimestamp()
            });
            
            // Log for Admin
            console.log(`Content ${targetId} (${targetType}) auto-hidden after ${reportCount} reports.`);
            
            // Optional: Notify Admins via a specific channel/FCM if needed
        }

        return { success: true, message: "Report submitted successfully." };

    } catch (e: any) {
        if (e instanceof HttpsError) throw e;
        console.error("Error reporting content:", e);
        throw new HttpsError("internal", e.message);
    }
};
