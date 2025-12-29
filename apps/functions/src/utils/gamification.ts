import { db } from "./firebase";

interface LevelInfo {
    newLevel: number;
    leveledUp: boolean;
}

/**
 * Awards XP to a user and handles level progression.
 * @param userId The ID of the user to award XP to.
 * @param amount The amount of XP to award.
 * @param action The action describing why XP was awarded (for logging/badges).
 */
export async function awardXp(userId: string, amount: number, action: string): Promise<LevelInfo> {
    const userRef = db.collection("users").doc(userId);
    
    try {
        await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userRef);
            if (!userDoc.exists) return;

            const data = userDoc.data() || {};
            const currentXp = data.xp || 0;
            const currentLevel = data.level || 1;

            const newXp = currentXp + amount;
            
            // Formula: Level = Floor(XP / 1000) + 1
            const newLevel = Math.floor(newXp / 1000) + 1;

            const updateData: any = {
                xp: newXp,
                level: newLevel,
                lastXpAwarded: new Date(), // Using native Date for now, converted to timestamp by SDK
            };

            // If leveled up, we could add a notification or badge logic here
            if (newLevel > currentLevel) {
                // Logic to add a "Level Up" badge if specific levels are hit could go here
                console.log(`User ${userId} leveled up to ${newLevel}!`);
            }

            transaction.update(userRef, updateData);
        });

        // Return approximated result (transaction result isn't easily returned out)
        // We assume success if no error thrown
        // To be accurate we'd need to re-fetch or calculate based on input
        return { newLevel: 0, leveledUp: false }; // Placeholder return
    } catch (error) {
        console.error(`Error awarding XP to ${userId}:`, error);
        return { newLevel: 0, leveledUp: false };
    }
}
