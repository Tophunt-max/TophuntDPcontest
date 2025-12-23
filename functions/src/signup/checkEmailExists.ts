import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { db } from "../utils/firebase";

export const checkEmailExists = onCall({ region: "asia-south1", cors: true }, async (request) => {
    if (!request.data || !request.data.email) {
        throw new HttpsError("invalid-argument", "The function must be called with an email.");
    }
    
    const email = request.data.email.trim();
    logger.info(`Request from user: ${request.auth?.uid}, app: ${request.app?.appId}`);
    logger.info(`Checking for email: ${email}`);

    try {
        const snapshot = await db.collection("users").where("email", "==", email).get();
        const exists = !snapshot.empty;
        logger.info(`Email '${email}' exists: ${exists}`);
        return { exists: exists };
    } catch (error: any) {
        logger.error("Error checking email:", error);
        throw new HttpsError("internal", "Could not check email existence. Internal error: " + error.message);
    }
});