"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.onSupportTicketCreated = exports.onReportCreated = void 0;
const firestore_1 = require("firebase-functions/v2/firestore");
// import * as admin from "firebase-admin";
// import { db } from "../utils/firebase";
const sender_1 = require("../notifications/sender");
// ------------------------------------------------------------------
// 1. Trigger: When a Report is Created
// ------------------------------------------------------------------
exports.onReportCreated = (0, firestore_1.onDocumentCreated)({
    document: "reports/{reportId}",
    region: "us-central1",
    // Removed database: 'dpcontest'
    maxInstances: 2,
}, async (event) => {
    const snapshot = event.data;
    if (!snapshot)
        return;
    const reportData = snapshot.data();
    if (!reportData)
        return;
    // Optional: Notify admins via Email or internal notification
    // For now, we just log it. You could add email logic here.
    console.log(`New Report Created: ${event.params.reportId}`, reportData);
    // If you want to notify admins via Push Notification:
    // This assumes you have a way to identify admins (e.g., hardcoded IDs or a query)
    /*
    const admins = await db.collection("users").where("role", "==", "admin").get();
    admins.forEach(adminDoc => {
       sendPushNotification(adminDoc.id, "New Report Alert", `Type: ${reportData.type}`, "admin_alert");
    });
    */
});
// ------------------------------------------------------------------
// 2. Trigger: When a Support Ticket is Created
// ------------------------------------------------------------------
exports.onSupportTicketCreated = (0, firestore_1.onDocumentCreated)({
    document: "support_tickets/{ticketId}",
    region: "us-central1",
    // Removed database: 'dpcontest'
    maxInstances: 2,
}, async (event) => {
    const snapshot = event.data;
    if (!snapshot)
        return;
    const ticketData = snapshot.data();
    if (!ticketData)
        return;
    console.log(`New Support Ticket: ${event.params.ticketId}`, ticketData);
    // Auto-reply to user acknowledging receipt
    const userId = ticketData.userId;
    if (userId) {
        await (0, sender_1.sendPushNotification)(userId, "Support Ticket Received", "We have received your request and will get back to you soon.", "support_auto_reply");
    }
});
//# sourceMappingURL=notifications.js.map