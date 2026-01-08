import { onDocumentCreated, onDocumentUpdated } from "firebase-functions/v2/firestore";
import { db } from "../utils/firebase";
import { createNotification } from "./utils";

// 1. Post Like Trigger
export const onPostLike = onDocumentCreated("posts/{postId}/likes/{userId}", async (event) => {
    const snapshot = event.data;
    if (!snapshot) return;

    const { postId, userId: likerId } = event.params;
    
    const postDoc = await db.collection("posts").doc(postId).get();
    if (!postDoc.exists) return;
    
    const postData = postDoc.data();
    const authorId = postData?.userId;

    if (authorId && authorId !== likerId) {
        const likerDoc = await db.collection("users").doc(likerId).get();
        const likerName = likerDoc.data()?.username || "Someone";

        await createNotification(authorId, {
            title: "New Like ❤️",
            body: `${likerName} liked your post.`,
            type: "like",
            targetId: postId,
            image: postData?.mediaUrl
        });
    }
});

// 2. Post Comment & Reply Trigger (MODIFIED)
export const onPostComment = onDocumentCreated("posts/{postId}/comments/{commentId}", async (event) => {
    const snapshot = event.data;
    if (!snapshot) return;

    const { postId } = event.params;
    const commentData = snapshot.data();
    const commenterId = commentData.userId;
    const parentId = commentData.parentId; // Check if it's a reply

    // Fetch Commenter Details
    const commenterDoc = await db.collection("users").doc(commenterId).get();
    const commenterName = commenterDoc.data()?.username || "Someone";

    // Fetch Post Details for Image
    const postDoc = await db.collection("posts").doc(postId).get();
    if (!postDoc.exists) return;
    const postData = postDoc.data();
    const postAuthorId = postData?.userId;

    // --- LOGIC FOR REPLIES ---
    if (parentId) {
        // Fetch the parent comment to find who we are replying to
        const parentCommentDoc = await db.collection("posts").doc(postId).collection("comments").doc(parentId).get();
        
        if (parentCommentDoc.exists) {
            const parentCommentData = parentCommentDoc.data();
            const parentAuthorId = parentCommentData?.userId;

            // Notify the author of the parent comment (if it's not the commenter themselves)
            if (parentAuthorId && parentAuthorId !== commenterId) {
                await createNotification(parentAuthorId, {
                    title: "New Reply ↩️",
                    body: `${commenterName} replied: "${commentData.text}"`,
                    type: "reply",
                    targetId: postId, // Navigate to post
                    image: postData?.mediaUrl
                });
            }
            return; 
        }
    }

    // --- LOGIC FOR DIRECT COMMENTS (No Parent ID) ---
    // Notify the Post Author (if not self-comment)
    if (postAuthorId && postAuthorId !== commenterId) {
        await createNotification(postAuthorId, {
            title: "New Comment 💬",
            body: `${commenterName} commented: "${commentData.text}"`,
            type: "comment",
            targetId: postId,
            image: postData?.mediaUrl
        });
    }
});

// 3. Contest Match Like Trigger
export const onMatchLike = onDocumentCreated("contestMatches/{matchId}/likes/{userId}", async (event) => {
    const snapshot = event.data;
    if (!snapshot) return;

    const { matchId, userId: likerId } = event.params;

    const matchDoc = await db.collection("contestMatches").doc(matchId).get();
    if (!matchDoc.exists) return;
    const matchData = matchDoc.data();
    
    // Notify BOTH participants
    const participants = [matchData?.creatorId, matchData?.opponentId].filter(id => id && id !== likerId);
    
    // Deduplicate
    const uniqueParticipants = [...new Set(participants)];

    if (uniqueParticipants.length > 0) {
        const likerDoc = await db.collection("users").doc(likerId).get();
        const likerName = likerDoc.data()?.username || "Someone";

        for (const pid of uniqueParticipants) {
            await createNotification(pid, {
                title: "Battle Like! 🔥",
                body: `${likerName} liked your battle.`,
                type: "contest",
                targetId: matchId
            });
        }
    }
});

// 4. Contest Match Comment Trigger
export const onMatchComment = onDocumentCreated("contestMatches/{matchId}/comments/{commentId}", async (event) => {
    const snapshot = event.data;
    if (!snapshot) return;

    const { matchId } = event.params;
    const commentData = snapshot.data();
    const commenterId = commentData.userId;

    const matchDoc = await db.collection("contestMatches").doc(matchId).get();
    if (!matchDoc.exists) return;
    const matchData = matchDoc.data();

    const participants = [matchData?.creatorId, matchData?.opponentId].filter(id => id && id !== commenterId);
    const uniqueParticipants = [...new Set(participants)];

    if (uniqueParticipants.length > 0) {
        const commenterDoc = await db.collection("users").doc(commenterId).get();
        const commenterName = commenterDoc.data()?.username || "Someone";

        for (const pid of uniqueParticipants) {
            await createNotification(pid, {
                title: "Battle Comment 💬",
                body: `${commenterName} commented on your battle.`,
                type: "contest",
                targetId: matchId
            });
        }
    }
});

// 5. Comment Like Trigger
export const onCommentLike = onDocumentCreated("posts/{postId}/comments/{commentId}/likes/{userId}", async (event) => {
    const snapshot = event.data;
    if (!snapshot) return;

    const { postId, commentId, userId: likerId } = event.params;

    // Fetch the comment to get the author
    const commentDoc = await db.collection("posts").doc(postId).collection("comments").doc(commentId).get();
    if (!commentDoc.exists) return;

    const commentData = commentDoc.data();
    const commentAuthorId = commentData?.userId;

    // Prevent self-notification
    if (commentAuthorId && commentAuthorId !== likerId) {
        const likerDoc = await db.collection("users").doc(likerId).get();
        const likerName = likerDoc.data()?.username || "Someone";
        const postDoc = await db.collection("posts").doc(postId).get();
        const postData = postDoc.data();

        await createNotification(commentAuthorId, {
            title: "Comment Liked ❤️",
            body: `${likerName} liked your comment.`,
            type: "comment-like",
            targetId: postId,
            image: postData?.mediaUrl
        });
    }
});

// 6. Battle Challenge Notifications
export const onMatchCreated = onDocumentCreated("contestMatches/{matchId}", async (event) => {
    const snapshot = event.data;
    if (!snapshot) return;
    
    const matchData = snapshot.data();
    const { creatorId, opponentId, status } = matchData;

    if (status === 'pending' && opponentId) {
        const creatorDoc = await db.collection("users").doc(creatorId).get();
        const creatorName = creatorDoc.data()?.username || "Someone";

        await createNotification(opponentId, {
            title: "New Challenge! ⚔️",
            body: `${creatorName} challenged you to a battle!`,
            type: "contest-invite",
            targetId: event.params.matchId,
            image: creatorDoc.data()?.photoURL
        });
    }
});

// 7. Battle Status Update & Follower Notifications
export const onMatchStatusUpdate = onDocumentUpdated("contestMatches/{matchId}", async (event) => {
    const change = event.data;
    if (!change) return;

    const newData = change.after.data();
    const oldData = change.before.data();
    const { matchId } = event.params;

    // Status changed from 'pending' to 'active'
    if (oldData.status === 'pending' && newData.status === 'active') {
        const creatorId = newData.creatorId;
        const opponentId = newData.opponentId;

        const creatorDoc = await db.collection("users").doc(creatorId).get();
        const opponentDoc = await db.collection("users").doc(opponentId).get();
        
        const creatorName = creatorDoc.data()?.username || "Someone";
        const opponentName = opponentDoc.data()?.username || "Someone";

        // Notify Creator
        await createNotification(creatorId, {
            title: "Challenge Accepted! 🚀",
            body: `${opponentName} accepted your challenge. Battle starts now!`,
            type: "contest-start",
            targetId: matchId,
            image: opponentDoc.data()?.photoURL
        });

        // Notify Creator's Followers
        const creatorFollowers = await db.collection("users").doc(creatorId).collection("followers").limit(100).get();
        const creatorPromises = creatorFollowers.docs.map(doc => createNotification(doc.id, {
            title: "Battle Alert! ⚔️",
            body: `${creatorName} started a battle with ${opponentName}.`,
            type: "contest-watch",
            targetId: matchId,
            image: creatorDoc.data()?.photoURL
        }));
        await Promise.all(creatorPromises);

        // Notify Opponent's Followers
        const opponentFollowers = await db.collection("users").doc(opponentId).collection("followers").limit(100).get();
        const opponentPromises = opponentFollowers.docs.map(doc => createNotification(doc.id, {
            title: "Battle Alert! ⚔️",
            body: `${opponentName} started a battle with ${creatorName}.`,
            type: "contest-watch",
            targetId: matchId,
            image: opponentDoc.data()?.photoURL
        }));
        await Promise.all(opponentPromises);
    }

    // Status changed to 'finished'
    if (oldData.status !== 'finished' && newData.status === 'finished') {
        const winnerId = newData.winnerId;
        if (winnerId) {
            await createNotification(winnerId, {
                title: "You Won! 🏆",
                body: "Congratulations! You won the battle.",
                type: "contest-win",
                targetId: matchId
            });
        }
        const participants = [newData.creatorId, newData.opponentId];
        const loserId = participants.find(id => id !== winnerId);
        if (loserId) {
             await createNotification(loserId, {
                title: "Battle Ended",
                body: "The battle has ended. Check the results.",
                type: "contest-end",
                targetId: matchId
            });
        }
    }
});

// 8. Wallet Transaction Notifications (Expanded)
export const onCoinTransaction = onDocumentCreated("coin_transactions/{transactionId}", async (event) => {
    const snapshot = event.data;
    if (!snapshot) return;

    const data = snapshot.data();
    const { userId, type, amount } = data;

    if (!userId || !amount) return;

    let title = "Coins Received 💰";
    let body = `You received ${amount} coins.`;

    switch (type) {
        case 'purchase':
            title = "Wallet Top-up Successful 💰";
            body = `Success! ${amount} Fish Coins have been added to your wallet.`;
            break;
        case 'reward':
        case 'battle_win':
            title = "Reward Earned! 🏆";
            body = `You earned ${amount} Fish Coins from your victory!`;
            break;
        case 'signup_bonus':
            title = "Welcome Bonus! 🎁";
            body = `Welcome to TopHunt! Here are ${amount} coins to get you started.`;
            break;
        case 'daily_login':
            title = "Daily Login Reward 🔥";
            body = `You claimed your daily login reward of ${amount} coins. Keep the streak!`;
            break;
        case 'referral_bonus':
            title = "Referral Reward 🤝";
            body = `Your friend joined using your code! You earned ${amount} coins.`;
            break;
        default:
            return; // Don't notify for unknown types
    }

    await createNotification(userId, {
        title,
        body,
        type: "wallet",
        targetId: "wallet"
    });
});

// 9. User Follow Notification & Milestones
export const onUserFollow = onDocumentCreated("users/{userId}/followers/{followerId}", async (event) => {
    const snapshot = event.data;
    if (!snapshot) return;

    const { userId, followerId } = event.params;

    const followerDoc = await db.collection("users").doc(followerId).get();
    if (!followerDoc.exists) return;

    const followerData = followerDoc.data();
    const followerName = followerData?.username || "Someone";

    await createNotification(userId, {
        title: "New Follower! 🌟",
        body: `${followerName} started following you.`,
        type: "follow",
        targetId: followerId,
        image: followerData?.photoURL
    });

    const userRef = db.collection("users").doc(userId);
    const userDoc = await userRef.get();
    const userData = userDoc.data();
    const currentFollowers = (userData?.followersCount || 0) + 1;
    await userRef.update({ followersCount: currentFollowers });

    const milestones = [10, 50, 100, 500, 1000, 5000];
    if (milestones.includes(currentFollowers)) {
         await createNotification(userId, {
            title: "Milestone Unlocked! 🎉",
            body: `Congratulations! You just reached ${currentFollowers} followers.`,
            type: "milestone",
            targetId: userId,
            image: userData?.photoURL
        });
    }
});

// 10. Content Share Trigger
export const onShare = onDocumentCreated("shares/{shareId}", async (event) => {
    const snapshot = event.data;
    if (!snapshot) return;

    const data = snapshot.data();
    const { userId, contentId, contentType, sharedBy } = data;

    if (userId && sharedBy && userId !== sharedBy) {
        const sharerDoc = await db.collection("users").doc(sharedBy).get();
        const sharerName = sharerDoc.data()?.username || "Someone";

        await createNotification(userId, {
            title: "Content Shared! 🚀",
            body: `Your ${contentType || 'post'} was shared by ${sharerName}.`,
            type: "share",
            targetId: contentId,
            image: sharerDoc.data()?.photoURL
        });
    }
});

// 11. Profile Visit Trigger
export const onProfileVisit = onDocumentCreated("users/{userId}/profileVisits/{visitorId}", async (event) => {
    const snapshot = event.data;
    if (!snapshot) return;

    const { userId, visitorId } = event.params;
    if (userId === visitorId) return;

    const visitorDoc = await db.collection("users").doc(visitorId).get();
    const visitorName = visitorDoc.data()?.username || "Someone";

    await createNotification(userId, {
        title: "New Profile Visitor 👀",
        body: `${visitorName} viewed your profile.`,
        type: "profile-visit",
        targetId: visitorId,
        image: visitorDoc.data()?.photoURL
    });
});

// 12. User Level Up Trigger (Based on XP)
export const onUserLevelUp = onDocumentUpdated("users/{userId}", async (event) => {
    const change = event.data;
    if (!change) return;

    const oldData = change.before.data();
    const newData = change.after.data();

    const oldXp = oldData.xp || 0;
    const newXp = newData.xp || 0;

    // Assuming 1000 XP = 1 Level
    const oldLevel = Math.floor(oldXp / 1000);
    const newLevel = Math.floor(newXp / 1000);

    if (newLevel > oldLevel) {
        await createNotification(event.params.userId, {
            title: "Level Up! 🆙",
            body: `Congratulations! You reached Level ${newLevel}. Keep battling!`,
            type: "level-up",
            targetId: "profile",
            image: newData.photoURL
        });
    }
});
