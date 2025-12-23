import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { db } from "../utils/firebase";

export const checkPhoneExists = onCall({ region: "asia-south1", cors: true }, async (request) => {
    const phone = request.data.phone.trim();
    logger.info(`Checking for phone: ${phone}`);

    try {
        const snapshot = await db.collection("users").where("phone", "==", phone).get();
        const exists = !snapshot.empty;
        logger.info(`Phone '${phone}' exists: ${exists}`);
        return { exists: exists };
    } catch (error) {
        logger.error("Error checking phone:", error);
        throw new HttpsError("internal", "Could not check phone existence.");
    }
});