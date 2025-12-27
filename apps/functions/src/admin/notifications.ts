import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { db, admin } from "../utils/firebase";

// Trigger for new Reports
export const onReportCreated = onDocumentCreated({
    document: "reports/{reportId}",
    database: "dpcontest"
}, async (event) => {
    const reportData = event.data?.data();
    if (!reportData) return;

    try {
        await db.collection("admin_notifications").add({
            title: "New User Report",
            message: `User reported a ${reportData.type || 'post'}: ${reportData.reason}`,
            link: "/reports",
            isRead: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            type: "report"
        });
    } catch (error) {
        console.error("Error creating report notification:", error);
    }
});

// Trigger for new Support Tickets
export const onSupportTicketCreated = onDocumentCreated({
    document: "support_tickets/{ticketId}",
    database: "dpcontest"
}, async (event) => {
    const ticketData = event.data?.data();
    if (!ticketData) return;

    try {
        await db.collection("admin_notifications").add({
            title: "New Support Query",
            message: `User ${ticketData.username || 'unknown'} sent a support request: ${ticketData.subject}`,
            link: "/support",
            isRead: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            type: "support"
        });
    } catch (error) {
        console.error("Error creating support notification:", error);
    }
});
