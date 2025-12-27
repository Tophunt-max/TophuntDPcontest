"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.onSupportTicketCreated = exports.onReportCreated = void 0;
const firestore_1 = require("firebase-functions/v2/firestore");
const firebase_1 = require("../utils/firebase");
// Trigger for new Reports
exports.onReportCreated = (0, firestore_1.onDocumentCreated)({
    document: "reports/{reportId}",
    database: "dpcontest"
}, async (event) => {
    var _a;
    const reportData = (_a = event.data) === null || _a === void 0 ? void 0 : _a.data();
    if (!reportData)
        return;
    try {
        await firebase_1.db.collection("admin_notifications").add({
            title: "New User Report",
            message: `User reported a ${reportData.type || 'post'}: ${reportData.reason}`,
            link: "/reports",
            isRead: false,
            createdAt: firebase_1.admin.firestore.FieldValue.serverTimestamp(),
            type: "report"
        });
    }
    catch (error) {
        console.error("Error creating report notification:", error);
    }
});
// Trigger for new Support Tickets
exports.onSupportTicketCreated = (0, firestore_1.onDocumentCreated)({
    document: "support_tickets/{ticketId}",
    database: "dpcontest"
}, async (event) => {
    var _a;
    const ticketData = (_a = event.data) === null || _a === void 0 ? void 0 : _a.data();
    if (!ticketData)
        return;
    try {
        await firebase_1.db.collection("admin_notifications").add({
            title: "New Support Query",
            message: `User ${ticketData.username || 'unknown'} sent a support request: ${ticketData.subject}`,
            link: "/support",
            isRead: false,
            createdAt: firebase_1.admin.firestore.FieldValue.serverTimestamp(),
            type: "support"
        });
    }
    catch (error) {
        console.error("Error creating support notification:", error);
    }
});
//# sourceMappingURL=notifications.js.map