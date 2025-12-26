
import React, { useState, useCallback, useEffect } from 'react';
import { GiftedChat } from 'react-native-gifted-chat';
import { firestore, auth } from '@/src/services/firebase/initFirebase';
import { collection, query, where, orderBy, onSnapshot, addDoc, doc, updateDoc, writeBatch } from 'firebase/firestore';
import { useLocalSearchParams } from 'expo-router';

export default function ChatScreen() {
  const [messages, setMessages] = useState([]);
  const { id: chatId } = useLocalSearchParams();
  const currentUser = auth.currentUser;

  useEffect(() => {
    // ... (onSnapshot for messages)
    
    // Mark messages as read
    const messagesRef = collection(firestore, 'chats', chatId, 'messages');
    const q = query(messagesRef, where('user._id', '!=', currentUser.uid));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const batch = writeBatch(firestore);
      snapshot.docs.forEach(document => {
        const message = document.data();
        if (!message.readBy || !message.readBy.includes(currentUser.uid)) {
          const messageRef = doc(firestore, 'chats', chatId, 'messages', document.id);
          batch.update(messageRef, {
            readBy: arrayUnion(currentUser.uid)
          });
        }
      });
      batch.commit();
    });
    
    return () => unsubscribe();
  }, [chatId, currentUser]);
  
  const renderTicks = (message) => {
    if (message.user._id !== currentUser.uid) {
      return null;
    }
    if (message.readBy && message.readBy.length > 1) { // Assuming group chat might have more than one other user
      return <Text style={{ color: 'blue', marginRight: 5 }}>✓✓</Text>;
    }
    if (message.sent) {
      return <Text style={{ color: 'gray', marginRight: 5 }}>✓</Text>;
    }
  };

  if (!currentUser) {
    return null;
  }

  return (
    <GiftedChat
      messages={messages}
      onSend={messages => onSend(messages)}
      user={{
        _id: currentUser.uid,
      }}
      renderTicks={renderTicks}
      // ... (other props)
    />
  );
}
