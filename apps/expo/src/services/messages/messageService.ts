
import {
  collection,
  query,
  where,
  getDocs,
  addDoc,
  serverTimestamp,
} from 'firebase/firestore';
import { firestore, auth } from '@/src/services/firebase/initFirebase';

export const startChat = async (otherUserId: string, otherUserData: any) => {
  try {
    const currentUser = auth.currentUser;
    if (!currentUser) throw new Error('User not authenticated');

    console.log("[startChat] Initializing chat with:", otherUserId);

    const chatsRef = collection(firestore, 'chats');

    // Check if a chat already exists between the two users
    // Note: 'users' array contains both UIDs
    const q = query(
      chatsRef,
      where('users', 'array-contains', currentUser.uid)
    );

    console.log("[startChat] Querying existing chats...");
    const querySnapshot = await getDocs(q);
    
    // Client-side filter to find the exact match (since array-contains is OR logic for lists if not careful, 
    // but here we find all chats where current user is present and then find one where other user is ALSO present)
    const existingChat = querySnapshot.docs.find(doc => {
        const users = doc.data().users;
        return Array.isArray(users) && users.includes(otherUserId);
    });

    if (existingChat) {
      console.log("[startChat] Found existing chat:", existingChat.id);
      return existingChat.id;
    } else {
      console.log("[startChat] Creating new chat...");
      // Create a new chat
      const newChatRef = await addDoc(chatsRef, {
        users: [currentUser.uid, otherUserId],
        usersData: [
          { uid: currentUser.uid, displayName: currentUser.displayName, photoURL: currentUser.photoURL },
          { uid: otherUserId, ...otherUserData },
        ],
        lastMessage: {
          text: 'Say hi!',
          createdAt: serverTimestamp(),
        },
        createdAt: serverTimestamp(),
      });
      console.log("[startChat] Created new chat:", newChatRef.id);
      return newChatRef.id;
    }
  } catch (error) {
    console.error("[startChat] Error:", error);
    throw error;
  }
};
