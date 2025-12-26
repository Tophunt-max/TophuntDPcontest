
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
  const currentUser = auth.currentUser;
  if (!currentUser) throw new Error('User not authenticated');

  const chatsRef = collection(firestore, 'chats');

  // Check if a chat already exists between the two users
  const q = query(
    chatsRef,
    where('users', 'array-contains', currentUser.uid)
  );

  const querySnapshot = await getDocs(q);
  const existingChat = querySnapshot.docs.find(doc =>
    doc.data().users.includes(otherUserId)
  );

  if (existingChat) {
    return existingChat.id;
  } else {
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
    return newChatRef.id;
  }
};
