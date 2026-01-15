import {
  collection,
  query,
  where,
  getDocs,
  addDoc,
  updateDoc,
  doc,
  serverTimestamp,
  orderBy,
  limit,
  Timestamp,
  increment,
  writeBatch,
  deleteDoc,
  getDoc,
  arrayUnion,
  arrayRemove,
} from 'firebase/firestore';
import { ref, set, onValue, onDisconnect, serverTimestamp as rtdbTimestamp } from 'firebase/database';
import { firestore, auth, database } from '@/src/services/firebase/initFirebase';
import { MessageType } from '@/src/types/schema';

const CLOUDFLARE_UPLOAD_URL = 'https://upload.tophunt.in/upload-message-media';

// --- 1. CHAT INITIALIZATION ---

export const startChat = async (otherUserId: string, otherUserData: { displayName: string, photoURL: string }) => {
  try {
    const currentUser = auth.currentUser;
    if (!currentUser) throw new Error('User not authenticated');

    const chatsRef = collection(firestore, 'chats');
    
    // Check if a chat already exists between these two specific participants
    const q = query(
      chatsRef, 
      where('participants', 'array-contains', currentUser.uid)
    );

    const querySnapshot = await getDocs(q);
    
    const existingChat = querySnapshot.docs.find(doc => {
        const data = doc.data();
        return data.participants && data.participants.includes(otherUserId);
    });

    if (existingChat) return existingChat.id;

    // Create new chat
    const newChatRef = await addDoc(chatsRef, {
      participants: [currentUser.uid, otherUserId],
      participantsData: {
        [currentUser.uid]: { displayName: currentUser.displayName || 'User', photoURL: currentUser.photoURL || '' },
        [otherUserId]: otherUserData
      },
      lastMessage: { text: 'Say hi!', senderId: 'system', type: 'text', createdAt: serverTimestamp() },
      unreadCount: { [currentUser.uid]: 0, [otherUserId]: 0 },
      blockedStatus: {
        [currentUser.uid]: false,
        [otherUserId]: false
      },
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    return newChatRef.id;
  } catch (error) {
    console.error("[startChat] Error:", error);
    throw error;
  }
};

export const sendMessage = async (chatId: string, content: string, type: MessageType = 'text', metadata?: any) => {
  try {
    const user = auth.currentUser;
    if (!user) return;

    const chatRef = doc(firestore, 'chats', chatId);
    const chatSnap = await getDoc(chatRef);
    
    if (!chatSnap.exists()) throw new Error('Chat does not exist');
    
    const chatData = chatSnap.data();
    const blockedStatus = chatData.blockedStatus || {};
    
    // Check if anyone has blocked the chat
    const isBlocked = Object.values(blockedStatus).some(status => status === true);
    if (isBlocked) throw new Error('Cannot send message in a blocked chat');

    const participants = chatData.participants;
    const otherUserId = participants.find((id: string) => id !== user.uid);
    
    const messagesRef = collection(firestore, 'chats', chatId, 'messages');
    await addDoc(messagesRef, { 
      chatId, 
      senderId: user.uid, 
      type, 
      content, 
      metadata: metadata || {}, 
      status: 'sent', 
      createdAt: serverTimestamp(), 
    });

    const updateData: any = { 
      lastMessage: { 
        text: type === 'text' ? content : `Sent a ${type.replace('_', ' ')}`, 
        senderId: user.uid, 
        type, 
        createdAt: serverTimestamp() 
      }, 
      updatedAt: serverTimestamp(), 
    };

    if (otherUserId) {
      updateData[`unreadCount.${otherUserId}`] = increment(1);
    }

    await updateDoc(chatRef, updateData);
  } catch (error) { 
    console.error("[sendMessage] Error:", error); 
    throw error; 
  }
};

export const blockUser = async (chatId: string, otherUserId: string) => {
    try {
        const user = auth.currentUser;
        if (!user) return;

        const batch = writeBatch(firestore);
        
        // 1. Update User's blocked list
        const userRef = doc(firestore, 'users', user.uid);
        batch.update(userRef, { 
            blockedUsers: arrayUnion(otherUserId) 
        });

        // 2. Update Chat's blocked status for THIS user
        const chatRef = doc(firestore, 'chats', chatId);
        batch.update(chatRef, { 
            [`blockedStatus.${user.uid}`]: true 
        });

        await batch.commit();
        return true;
    } catch (error) { 
        console.error("[blockUser] Error:", error); 
        return false;
    }
};

export const unblockUser = async (chatId: string, otherUserId: string) => {
    try {
        const user = auth.currentUser;
        if (!user) return;

        const batch = writeBatch(firestore);
        
        // 1. Remove from User's blocked list
        const userRef = doc(firestore, 'users', user.uid);
        batch.update(userRef, { 
            blockedUsers: arrayRemove(otherUserId) 
        });

        // 2. Update Chat's blocked status
        const chatRef = doc(firestore, 'chats', chatId);
        batch.update(chatRef, { 
            [`blockedStatus.${user.uid}`]: false 
        });

        await batch.commit();
        return true;
    } catch (error) { 
        console.error("[unblockUser] Error:", error); 
        return false;
    }
};

export const reportTarget = async (targetId: string, targetType: 'user' | 'post' | 'message', reason: string) => {
    try {
        if (!auth.currentUser) return;
        await addDoc(collection(firestore, 'reports'), { 
            reporterId: auth.currentUser.uid, 
            targetId, 
            targetType, 
            reason, 
            status: 'pending', 
            createdAt: serverTimestamp(), 
        });
        return true;
    } catch (error) { 
        console.error("[reportTarget] Error:", error);
        return false; 
    }
};

export const markChatAsRead = async (chatId: string) => {
    try {
        const user = auth.currentUser;
        if (!user) return;

        // Reset the current user's unread count for this chat
        await updateDoc(doc(firestore, 'chats', chatId), { 
            [`unreadCount.${user.uid}`]: 0 
        });

        const messagesRef = collection(firestore, 'chats', chatId, 'messages');
        
        // FIX: Firestore doesn't allow multiple '!=' filters.
        // We only filter by status != 'seen' and then filter by senderId in JS.
        const q = query(
            messagesRef, 
            where('status', '!=', 'seen'), 
            limit(50)
        );

        const snapshot = await getDocs(q);
        if (snapshot.empty) return;

        const batch = writeBatch(firestore);
        let hasUpdates = false;

        snapshot.docs.forEach((document) => { 
            const data = document.data();
            // Filter by senderId here (only mark other people's messages as seen)
            if (data.senderId !== user.uid) {
                batch.update(document.ref, { status: 'seen' }); 
                hasUpdates = true;
            }
        });

        if (hasUpdates) {
            await batch.commit();
        }
    } catch (error) { 
        console.error("[markChatAsRead] Error:", error); 
    }
};

export const deleteMessage = async (chatId: string, messageId: string) => {
  try {
    await deleteDoc(doc(firestore, 'chats', chatId, 'messages', messageId));
    
    const messagesRef = collection(firestore, 'chats', chatId, 'messages');
    const snapshot = await getDocs(query(
        messagesRef, 
        orderBy('createdAt', 'desc'), 
        limit(1)
    ));

    const chatRef = doc(firestore, 'chats', chatId);
    if (!snapshot.empty) {
      const lastMsg = snapshot.docs[0].data();
      await updateDoc(chatRef, { 
          lastMessage: { 
              text: lastMsg.content, 
              senderId: lastMsg.senderId, 
              type: lastMsg.type, 
              createdAt: lastMsg.createdAt 
          } 
      });
    }
  } catch (error) { 
      console.error("[deleteMessage] Error:", error); 
  }
};

export const setChatBackground = async (chatId: string, imageUrl: string) => {
    try {
        await updateDoc(doc(firestore, 'chats', chatId), { 
            'settings.backgroundImage': imageUrl 
        });
    } catch (error) {
        console.error("[setChatBackground] Error:", error);
    }
};

export const uploadAndSendMedia = async (chatId: string, fileUri: string, type: string, duration?: number) => {
    try {
        const user = auth.currentUser;
        if (!user) throw new Error('User not authenticated');

        const formData = new FormData();
        formData.append('file', { 
            uri: fileUri, 
            type: type === 'voice_note' ? 'audio/m4a' : 'video/mp4', 
            name: 'file' 
        } as any);
        formData.append('userId', user.uid);
        formData.append('chatId', chatId);
        formData.append('type', type);

        const response = await fetch(CLOUDFLARE_UPLOAD_URL, { 
            method: 'POST', 
            body: formData 
        });

        const result = await response.json();
        if (result.success) {
            // After successful upload, also send the message to Firestore
            await sendMessage(chatId, result.url, type as MessageType);
            return result.url;
        }
        throw new Error(result.error || 'Upload failed');
    } catch (error) {
        console.error("[uploadAndSendMedia] Error:", error);
        throw error;
    }
};

export const setTypingStatus = (chatId: string, isTyping: boolean) => {
    if (auth.currentUser) {
        set(ref(database, `status/${chatId}/${auth.currentUser.uid}/typing`), isTyping);
    }
};

export const updateUserPresence = () => {
    if (!auth.currentUser) return;
    const userStatusRef = ref(database, `presence/${auth.currentUser.uid}`);
    onValue(ref(database, '.info/connected'), (snapshot) => {
        if (snapshot.val() === false) return;
        onDisconnect(userStatusRef).set({ state: 'offline', last_changed: rtdbTimestamp() }).then(() => {
            set(userStatusRef, { state: 'online', last_changed: rtdbTimestamp() });
        });
    });
};
