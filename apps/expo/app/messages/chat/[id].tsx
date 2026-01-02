
import React, { useState, useCallback, useEffect } from 'react';
import { GiftedChat, IMessage, BubbleProps, TimeProps, InputToolbarProps, Bubble } from 'react-native-gifted-chat';
import { firestore } from '@/src/services/firebase/initFirebase';
import { collection, query, where, orderBy, onSnapshot, addDoc, doc, updateDoc, writeBatch, arrayUnion } from 'firebase/firestore';
import { useLocalSearchParams } from 'expo-router';
import { View, Text, ActivityIndicator, StyleSheet, TouchableOpacity } from 'react-native';
import { useAuth } from '@/src/hooks/useAuth';
import ChatHeader from '@/components/chat/ChatHeader';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors } from '@/constants/theme'; // Assuming Colors are defined here

export default function ChatScreen() {
  const { user: firebaseUser, loading: authLoading } = useAuth();
  const [messages, setMessages] = useState<IMessage[]>([]);
  const { id: chatId } = useLocalSearchParams();
  const [isLoadingMessages, setIsLoadingMessages] = useState(true);

  // Placeholder for recipient details - in a real app, you'd fetch this based on chatId
  const recipientName = "John Doe";
  const recipientAvatar = "https://i.pravatar.cc/300"; 

  const currentUser = firebaseUser;

  useEffect(() => {
    if (authLoading || !currentUser || !chatId) {
      if (!authLoading) {
        setIsLoadingMessages(false);
      }
      return;
    }

    console.log(`[ChatScreen] Subscribing to chat: ${chatId}`);
    const messagesRef = collection(firestore, 'chats', chatId as string, 'messages');
    const q = query(messagesRef, orderBy('createdAt', 'desc'));

    const unsubscribe = onSnapshot(q, (snapshot) => {
      console.log(`[ChatScreen] Received ${snapshot.docs.length} messages.`);
      const loadedMessages = snapshot.docs.map(doc => {
        const data = doc.data();
        return {
          _id: doc.id,
          text: data.text,
          createdAt: data.createdAt.toDate(),
          user: data.user,
          sent: true,
          received: true,
          readBy: data.readBy
        } as IMessage;
      });
      setMessages(loadedMessages);
      setIsLoadingMessages(false);
    }, (error) => {
      console.error("[ChatScreen] Error fetching messages:", error);
      setIsLoadingMessages(false);
    });
    
    const unreadQuery = query(messagesRef, where('user._id', '!=', currentUser.uid));
    const unsubscribeRead = onSnapshot(unreadQuery, (snapshot) => {
        const batch = writeBatch(firestore);
        let hasUpdates = false;
        snapshot.docs.forEach(document => {
            const message = document.data();
            if (!message.readBy || !message.readBy.includes(currentUser.uid)) {
                const messageRef = doc(firestore, 'chats', chatId as string, 'messages', document.id);
                batch.update(messageRef, {
                    readBy: arrayUnion(currentUser.uid)
                });
                hasUpdates = true;
            }
        });
        if (hasUpdates) {
            batch.commit();
            console.log("[ChatScreen] Marked messages as read.");
        }
    });

    return () => {
      console.log(`[ChatScreen] Unsubscribing from chat: ${chatId}`);
      unsubscribe();
      unsubscribeRead();
    }
  }, [chatId, currentUser, authLoading]);

  const onSend = useCallback(async (newMessages: IMessage[] = []) => {
    if (!currentUser || !chatId) return;
    setMessages(previousMessages => GiftedChat.append(previousMessages, newMessages));
    
    const { _id, createdAt, text, user } = newMessages[0];
    try {
      await addDoc(collection(firestore, 'chats', chatId as string, 'messages'), {
          _id,
          createdAt,
          text,
          user,
          readBy: [currentUser!.uid]
      });
      console.log("[ChatScreen] Message sent and added to Firestore.");
      
      await updateDoc(doc(firestore, 'chats', chatId as string), {
          lastMessage: text,
          lastMessageTime: createdAt,
          users: arrayUnion(currentUser!.uid)
      });
      console.log("[ChatScreen] Chat document updated with last message.");
    } catch (error) {
      console.error("[ChatScreen] Error sending message:", error);
    }

  }, [chatId, currentUser]);

  const renderBubble = (props: BubbleProps<IMessage>) => {
    const isCurrentUser = props.currentMessage?.user._id === currentUser?.uid;
    return (
        <Bubble
          {...props}
          wrapperStyle={{
            left: {
              backgroundColor: '#ECECEC',
              borderBottomLeftRadius: 5,
              borderTopLeftRadius: 5,
              borderBottomRightRadius: 20,
              borderTopRightRadius: 20,
              marginLeft: -40, // Adjust as needed to align with image
            },
            right: {
              backgroundColor: '#FF4D67',
              borderBottomLeftRadius: 20,
              borderTopLeftRadius: 20,
              borderBottomRightRadius: 5,
              borderTopRightRadius: 5,
              marginRight: 10, // Adjust as needed to align with image
            },
          }}
          textStyle={{
            left: {
              color: 'black',
            },
            right: {
              color: 'white',
            },
          }}
        />
    );
  };

  const renderTime = (props: TimeProps<IMessage>) => {
    const isCurrentUser = props.currentMessage?.user._id === currentUser?.uid;
    return (
      <View style={isCurrentUser ? styles.rightMessageStatus : styles.leftMessageStatus}>
        <Text style={styles.timeText}>
          {props.currentMessage?.createdAt ? new Date(props.currentMessage.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
        </Text>
      </View>
    );
  };

  const renderInputToolbar = (props: InputToolbarProps<IMessage>) => (
    <View style={styles.inputToolbarContainer}>
      <GiftedChat.InputToolbar
        {...props}
        containerStyle={styles.inputToolbar}
        renderActions={() => (
          <View style={styles.inputActions}>
            {/* Add any left-side icons here if needed */}
          </View>
        )}
        renderSend={(sendProps) => (
          <TouchableOpacity onPress={sendProps.onSend} style={styles.microphoneButton}>
            <Ionicons name="mic-sharp" size={24} color="white" />
          </TouchableOpacity>
        )}
        textInputStyle={styles.textInput}
      />
    </View>
  );

  if (authLoading) {
    return <View style={styles.centeredContainer}><ActivityIndicator size="large" color="#FF4D67" /></View>;
  }

  if (!currentUser) {
    return <View style={styles.centeredContainer}><Text>Please log in to view chats.</Text></View>;
  }

  if (!chatId) {
    return <View style={styles.centeredContainer}><Text>No chat selected. Please go back and select a user.</Text></View>;
  }

  if (isLoadingMessages) {
    return <View style={styles.centeredContainer}><ActivityIndicator size="large" color="#FF4D67" /></View>;
  }

  return (
    <View style={{ flex: 1 }}>
      <ChatHeader recipientName={recipientName} recipientAvatar={recipientAvatar} />
      <GiftedChat
        messages={messages}
        onSend={messages => onSend(messages)}
        user={{
          _id: currentUser.uid,
        }}
        renderBubble={renderBubble}
        renderTime={renderTime}
        renderInputToolbar={renderInputToolbar}
        minInputToolbarHeight={60}
        // Removed renderChatEmpty to ensure input is visible
        renderFooter={() => (
          messages.length === 0 && !isLoadingMessages ? (
            <View style={styles.emptyChatFooter}>
            <Text style={styles.noMessagesText}>No messages yet. Start the conversation!</Text>
          </View>
        ) : null
      )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  centeredContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f0f2f5',
  },
  emptyChatFooter: {
    paddingBottom: 10,
    alignItems: 'center',
    backgroundColor: '#f0f2f5',
  },
  noMessagesText: {
    fontSize: 16,
    color: '#666',
    textAlign: 'center',
    paddingHorizontal: 20,
  },
  inputToolbarContainer: {
    backgroundColor: '#fff',
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderTopWidth: 1,
    borderTopColor: '#f0f0f0',
  },
  inputToolbar: {
    backgroundColor: '#F0F0F0',
    borderRadius: 25,
    marginLeft: 0,
    marginRight: 0,
    marginBottom: 5,
    elevation: 0, // Remove shadow on Android
    borderWidth: 0,
    paddingHorizontal: 10,
    justifyContent: 'center', // Center content vertically
    alignItems: 'center', // Center content horizontally
    height: 50, // Fixed height for the input toolbar
  },
  textInput: {
    flex: 1,
    marginRight: 10,
    fontSize: 16,
    lineHeight: 24,
    marginTop: 0,
    marginBottom: 0,
    color: 'black',
  },
  inputActions: {
    // Add styles for any left-side icons if needed
  },
  microphoneButton: {
    backgroundColor: '#FF4D67',
    borderRadius: 20,
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 10,
  },
  rightMessageStatus: {
    alignSelf: 'flex-end',
    marginRight: 10,
    marginTop: 2,
    marginBottom: 10,
  },
  leftMessageStatus: {
    alignSelf: 'flex-start',
    marginLeft: 70, // Adjust to align with image
    marginTop: 2,
    marginBottom: 10,
  },
  timeText: {
    fontSize: 12,
    color: 'gray',
  },
});
