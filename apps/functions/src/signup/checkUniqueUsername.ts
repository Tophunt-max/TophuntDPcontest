import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { db } from "../utils/firebase";

export const checkUniqueUsername = onCall({ region: "asia-south1", cors: true }, async (request) => {
    const username = request.data.username.trim();
    logger.info(`Checking for username: ${username}`);

    try {
        const snapshot = await db.collection("users").where("username", "==", username).get();
        const exists = !snapshot.empty;
        logger.info(`Username '${username}' exists: ${exists}`);
        return { exists: exists };
    } catch (error) {
        logger.error("Error checking username:", error);
        throw new HttpsError("internal", "Could not check username uniqueness.");
    }
});