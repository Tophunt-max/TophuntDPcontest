import { db } from "./firebase";
import { FieldValue } from "firebase-admin/firestore";
import { sendPushNotification } from "../notifications/sender";

interface LevelInfo {
    newLevel: number;
    leveledUp: boolean;
}

interface Badge {
    level: number;
    name: string;
    icon: string;
}

export interface GamificationSettings {
    xpThreshold: number;
    xpIncrement: number;
    dailyLoginReward: number;
    contestJoinReward: number;
    matchWinReward: number;
    voteRewardXP: number;
    contestJoinXP: number;
    badges: Badge[];
}

const DEFAULT_SETTINGS: GamificationSettings = {
    xpThreshold: 500,
    xpIncrement: 500,
    dailyLoginReward: 10,
    contestJoinReward: 50,
    matchWinReward: 100,
    voteRewardXP: 10,
    contestJoinXP: 50,
    badges: [],
};

/**
 * Fetches gamification settings from Firestore.
 */
export async function getGamificationSettings(): Promise<GamificationSettings> {
    try {
        const doc = await db.collection("settings").doc("gamification").get();
        if (!doc.exists) return DEFAULT_SETTINGS;
        const data = doc.data() || {};
        return { 
            ...DEFAULT_SETTINGS, 
            ...data,
            badges: data.badges || []
        } as GamificationSettings;
    } catch (error) {
        console.error("Error fetching gamification settings:", error);
        return DEFAULT_SETTINGS;
    }
}

/**
 * Calculates Level based on XP and custom thresholds. 
 */
export function calculateLevel(xp: number, threshold: number, increment: number): number {
    let level = 1;
    let currentThreshold = threshold;
    let accumulatedXp = 0;

    while (xp >= accumulatedXp + currentThreshold) {
        accumulatedXp += currentThreshold;
        level++;
        currentThreshold += increment; 
    }
    return level;
}

/**
 * Central function to award XP and Coins based on action.
 */
export async function awardReward(userId: string, action: 'daily_login' | 'contest_join' | 'match_win' | 'battle_vote'): Promise<void> {
    const settings = await getGamificationSettings();
    const userRef = db.collection("users").doc(userId);
    
    let xpAmount = 0;
    let coinAmount = 0;

    switch (action) {
        case 'daily_login':
            coinAmount = settings.dailyLoginReward;
            xpAmount = 20; 
            break;
        case 'contest_join':
            coinAmount = settings.contestJoinReward;
            xpAmount = settings.contestJoinXP;
            break;
        case 'match_win':
            coinAmount = settings.matchWinReward;
            xpAmount = 100;
            break;
        case 'battle_vote':
            xpAmount = settings.voteRewardXP;
            break;
    }

    if (xpAmount <= 0 && coinAmount <= 0) return;

    let leveledUpTo = -1;
    let awardedBadge: Badge | null = null;

    await db.runTransaction(async (transaction) => {
        const userDoc = await transaction.get(userRef);
        if (!userDoc.exists) return;

        const data = userDoc.data() || {};
        const currentXp = data.xp || 0;
        const currentLevel = data.level || 1;
        const currentCoins = data.Dpcoin || data.fishCoins || data.coins || 0;
        const currentBadges = data.badges || [];

        const newXp = currentXp + xpAmount;
        const newCoins = currentCoins + coinAmount;
        const newLevel = calculateLevel(newXp, settings.xpThreshold, settings.xpIncrement);

        const updates: any = {
            xp: newXp,
            level: newLevel,
            Dpcoin: newCoins, // Renamed to Dpcoin
            updatedAt: FieldValue.serverTimestamp(),
        };

        if (newLevel > currentLevel) {
            leveledUpTo = newLevel;
            // Check for badge at this new level
            const badge = settings.badges.find(b => b.level === newLevel);
            if (badge) {
                awardedBadge = badge;
                // Add badge if not already owned
                if (!currentBadges.some((b: any) => (b as any).name === badge.name)) {
                    updates.badges = FieldValue.arrayUnion(badge);
                }
            }
        }

        transaction.update(userRef, updates);
    });

    // Send notifications
    if (leveledUpTo > 0) {
        await sendPushNotification(
            userId, 
            "Level Up! 🌟", 
            `Congratulations! You've reached Level ${leveledUpTo}.`, 
            "level_up"
        );
        
        if (awardedBadge) {
            await sendPushNotification(
                userId, 
                "New Badge Earned! 🏅", 
                `You've unlocked the '${(awardedBadge as Badge).name}' badge!`, 
                "badge_earned"
            );
        }
    }

    if (coinAmount > 0) {
        await sendPushNotification(userId, "Reward Received! 🪙", `You earned ${coinAmount} Dpcoins!`, "reward_received");
    }
}

/**
 * Legacy support for awardXp (updated to handle badges too)
 */
export async function awardXp(userId: string, amount: number, action: string): Promise<LevelInfo> {
    const settings = await getGamificationSettings();
    const userRef = db.collection("users").doc(userId);
    let leveledUp = false;
    let finalLevel = 1;

    await db.runTransaction(async (transaction) => {
        const userDoc = await transaction.get(userRef);
        if (!userDoc.exists) return;

        const data = userDoc.data() || {};
        const currentXp = data.xp || 0;
        const currentLevel = data.level || 1;
        const currentBadges = data.badges || [];

        const newXp = currentXp + amount;
        const newLevel = calculateLevel(newXp, settings.xpThreshold, settings.xpIncrement);

        finalLevel = newLevel;
        leveledUp = newLevel > currentLevel;

        const updates: any = {
            xp: newXp,
            level: newLevel,
            updatedAt: FieldValue.serverTimestamp(),
        };

        if (leveledUp) {
            const badge = settings.badges.find(b => b.level === newLevel);
            if (badge && !currentBadges.some((b: any) => b.name === badge.name)) {
                updates.badges = FieldValue.arrayUnion(badge);
            }
        }

        transaction.update(userRef, updates);
    });

    if (leveledUp) {
        await sendPushNotification(userId, "Level Up! 🌟", `You reached Level ${finalLevel}.`, "level_up");
    }

    return { newLevel: finalLevel, leveledUp };
}
