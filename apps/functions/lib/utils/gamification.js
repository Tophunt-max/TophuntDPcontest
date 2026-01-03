"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getGamificationSettings = getGamificationSettings;
exports.calculateLevel = calculateLevel;
exports.awardReward = awardReward;
exports.awardXp = awardXp;
const firebase_1 = require("./firebase");
const firestore_1 = require("firebase-admin/firestore");
const sender_1 = require("../notifications/sender");
const DEFAULT_SETTINGS = {
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
async function getGamificationSettings() {
    try {
        const doc = await firebase_1.db.collection("settings").doc("gamification").get();
        if (!doc.exists)
            return DEFAULT_SETTINGS;
        const data = doc.data() || {};
        return Object.assign(Object.assign(Object.assign({}, DEFAULT_SETTINGS), data), { badges: data.badges || [] });
    }
    catch (error) {
        console.error("Error fetching gamification settings:", error);
        return DEFAULT_SETTINGS;
    }
}
/**
 * Calculates Level based on XP and custom thresholds.
 */
function calculateLevel(xp, threshold, increment) {
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
async function awardReward(userId, action) {
    const settings = await getGamificationSettings();
    const userRef = firebase_1.db.collection("users").doc(userId);
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
    if (xpAmount <= 0 && coinAmount <= 0)
        return;
    let leveledUpTo = -1;
    let awardedBadge = null;
    await firebase_1.db.runTransaction(async (transaction) => {
        const userDoc = await transaction.get(userRef);
        if (!userDoc.exists)
            return;
        const data = userDoc.data() || {};
        const currentXp = data.xp || 0;
        const currentLevel = data.level || 1;
        const currentCoins = data.Dpcoin || data.fishCoins || data.coins || 0;
        const currentBadges = data.badges || [];
        const newXp = currentXp + xpAmount;
        const newCoins = currentCoins + coinAmount;
        const newLevel = calculateLevel(newXp, settings.xpThreshold, settings.xpIncrement);
        const updates = {
            xp: newXp,
            level: newLevel,
            Dpcoin: newCoins, // Renamed to Dpcoin
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        };
        if (newLevel > currentLevel) {
            leveledUpTo = newLevel;
            // Check for badge at this new level
            const badge = settings.badges.find(b => b.level === newLevel);
            if (badge) {
                awardedBadge = badge;
                // Add badge if not already owned
                if (!currentBadges.some((b) => b.name === badge.name)) {
                    updates.badges = firestore_1.FieldValue.arrayUnion(badge);
                }
            }
        }
        transaction.update(userRef, updates);
    });
    // Send notifications
    if (leveledUpTo > 0) {
        await (0, sender_1.sendPushNotification)(userId, "Level Up! 🌟", `Congratulations! You've reached Level ${leveledUpTo}.`, "level_up");
        if (awardedBadge) {
            await (0, sender_1.sendPushNotification)(userId, "New Badge Earned! 🏅", `You've unlocked the '${awardedBadge.name}' badge!`, "badge_earned");
        }
    }
    if (coinAmount > 0) {
        await (0, sender_1.sendPushNotification)(userId, "Reward Received! 🪙", `You earned ${coinAmount} Dpcoins!`, "reward_received");
    }
}
/**
 * Legacy support for awardXp (updated to handle badges too)
 */
async function awardXp(userId, amount, action) {
    const settings = await getGamificationSettings();
    const userRef = firebase_1.db.collection("users").doc(userId);
    let leveledUp = false;
    let finalLevel = 1;
    await firebase_1.db.runTransaction(async (transaction) => {
        const userDoc = await transaction.get(userRef);
        if (!userDoc.exists)
            return;
        const data = userDoc.data() || {};
        const currentXp = data.xp || 0;
        const currentLevel = data.level || 1;
        const currentBadges = data.badges || [];
        const newXp = currentXp + amount;
        const newLevel = calculateLevel(newXp, settings.xpThreshold, settings.xpIncrement);
        finalLevel = newLevel;
        leveledUp = newLevel > currentLevel;
        const updates = {
            xp: newXp,
            level: newLevel,
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        };
        if (leveledUp) {
            const badge = settings.badges.find(b => b.level === newLevel);
            if (badge && !currentBadges.some((b) => b.name === badge.name)) {
                updates.badges = firestore_1.FieldValue.arrayUnion(badge);
            }
        }
        transaction.update(userRef, updates);
    });
    if (leveledUp) {
        await (0, sender_1.sendPushNotification)(userId, "Level Up! 🌟", `You reached Level ${finalLevel}.`, "level_up");
    }
    return { newLevel: finalLevel, leveledUp };
}
//# sourceMappingURL=gamification.js.map