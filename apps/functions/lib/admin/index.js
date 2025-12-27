"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.unblockUser = exports.deletePost = exports.setAdminRole = void 0;
const https_1 = require("firebase-functions/v2/https");
const firebase_1 = require("../utils/firebase");
exports.setAdminRole = (0, https_1.onCall)(async (request) => {
    var _a;
    if (!request.auth) {
        throw new https_1.HttpsError("unauthenticated", "The function must be called while authenticated.");
    }
    const callerUid = request.auth.uid;
    const callerDoc = await firebase_1.db.collection("users").doc(callerUid).get();
    if (!callerDoc.exists || ((_a = callerDoc.data()) === null || _a === void 0 ? void 0 : _a.role) !== "admin") {
        throw new https_1.HttpsError("permission-denied", "Only admins can set admin roles.");
    }
    const { uid } = request.data;
    if (!uid) {
        throw new https_1.HttpsError("invalid-argument", "The function must be called with a 'uid'.");
    }
    try {
        await firebase_1.auth.setCustomUserClaims(uid, { role: "admin" });
        await firebase_1.db.collection("users").doc(uid).update({
            role: "admin",
        });
        return { message: `Successfully set admin role for user ${uid}` };
    }
    catch (error) {
        console.error("Error setting admin role:", error);
        throw new https_1.HttpsError("internal", "An error occurred while setting the admin role.");
    }
});
exports.deletePost = (0, https_1.onCall)(async (request) => {
    var _a;
    if (!request.auth) {
        throw new https_1.HttpsError("unauthenticated", "The function must be called while authenticated.");
    }
    // Check if the requester is an admin or moderator
    const callerUid = request.auth.uid;
    const callerDoc = await firebase_1.db.collection("users").doc(callerUid).get();
    const callerRole = (_a = callerDoc.data()) === null || _a === void 0 ? void 0 : _a.role;
    if (!callerDoc.exists || (callerRole !== "admin" && callerRole !== "moderator")) {
        throw new https_1.HttpsError("permission-denied", "Only admins or moderators can delete posts.");
    }
    const { postId } = request.data;
    if (!postId) {
        throw new https_1.HttpsError("invalid-argument", "The function must be called with a 'postId'.");
    }
    try {
        await firebase_1.db.collection("posts").doc(postId).delete();
        // In a real app, you'd also delete the image from S3/Storage here
        return { message: `Successfully deleted post ${postId}` };
    }
    catch (error) {
        console.error("Error deleting post:", error);
        throw new https_1.HttpsError("internal", "An error occurred while deleting the post.");
    }
});
exports.unblockUser = (0, https_1.onCall)(async (request) => {
    var _a;
    if (!request.auth) {
        throw new https_1.HttpsError("unauthenticated", "The function must be called while authenticated.");
    }
    const callerUid = request.auth.uid;
    const callerDoc = await firebase_1.db.collection("users").doc(callerUid).get();
    if (!callerDoc.exists || ((_a = callerDoc.data()) === null || _a === void 0 ? void 0 : _a.role) !== "admin") {
        throw new https_1.HttpsError("permission-denied", "Only admins can unblock users.");
    }
    const { uid } = request.data;
    if (!uid) {
        throw new https_1.HttpsError("invalid-argument", "The function must be called with a 'uid'.");
    }
    try {
        await firebase_1.db.collection("users").doc(uid).update({
            status: "active", // or whatever field you use to block
            blocked: false
        });
        return { message: `Successfully unblocked user ${uid}` };
    }
    catch (error) {
        console.error("Error unblocking user:", error);
        throw new https_1.HttpsError("internal", "An error occurred while unblocking the user.");
    }
});
//# sourceMappingURL=index.js.map