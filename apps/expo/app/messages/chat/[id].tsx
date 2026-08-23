
import React, { useState, useCallback, useEffect } from 'react';
import { GiftedChat, IMessage, BubbleProps, TimeProps, InputToolbarProps, Bubble } from 'react-native-gifted-chat';
import { readApi, callApi } from '@/src/services/api';
import { live } from '@/src/services/realtime';
import { useLocalSearchParams } from 'expo-router';
import { View, Text, ActivityIndicator, StyleSheet, TouchableOpacity } from 'react-native';
import { useAuth } from '@/src/hooks/useAuth';
import ChatHeader from '@/components/chat/ChatHeader';
import { Ionicons } from '@/src/lib/icons';
import { Colors } from '@/constants/theme'; // Assuming Colors are defined here

export default function ChatScreen() {
  const { user: firebaseUser, loading: authLoading } = useAuth();
  const [messages, setMessages] = useState<IMessage[]>([]);
  const params = useLocalSearchParams<{ id?: string; name?: string; avatar?: string }>();
  const chatId = params.id;
  const [isLoadingMessages, setIsLoadingMessages] = useState(true);

  // Recipient identity is passed as query params by whoever opened the chat
  // (the chat list and the profile "Message" button both already know the other
  // user). Falls back to a neutral label for a cold deep-link; the avatar then
  // renders local initials rather than a third-party placeholder image.
  const recipientName = params.name || 'Chat';
  const recipientAvatar = params.avatar || null;

  const currentUser = firebaseUser;

  useEffect(() => {
    if (authLoading || !currentUser || !chatId) {
      if (!authLoading) {
        setIsLoadingMessages(false);
      }
      return;
    }

    // Instant push via the chat's WebSocket channel (polling is only a fallback).
    const unsubscribe = live<any[]>(
      `chat:${chatId}`,
      () => readApi(`/read/chats/${chatId}/messages`),
      (rows) => {
        // Server returns oldest-first; GiftedChat wants newest-first.
        const loaded = (rows || [])
          .map((m) => ({
            _id: m.id,
            text: m.text,
            createdAt: new Date(m.createdAt),
            user: { _id: m.senderId },
            sent: true,
            received: !!m.read,
          } as IMessage))
          .reverse();
        setMessages(loaded);
        setIsLoadingMessages(false);
      },
      { filter: (e) => e.type === 'message' },
    );

    // Mark incoming messages as read (best-effort).
    callApi('markChatRead', { chatId }).catch(() => {});

    return () => {
      unsubscribe();
    };
  }, [chatId, currentUser, authLoading]);

  const onSend = useCallback(async (newMessages: IMessage[] = []) => {
    if (!currentUser || !chatId) return;
    setMessages(previousMessages => GiftedChat.append(previousMessages, newMessages));
    const { text } = newMessages[0];
    try {
      await callApi('sendMessage', { chatId, text });
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

  const InputToolbarComp: any = (GiftedChat as any).InputToolbar;
  const renderInputToolbar = (props: InputToolbarProps<IMessage>) => (
    <View style={styles.inputToolbarContainer}>
      <InputToolbarComp
        {...props}
        containerStyle={styles.inputToolbar}
        renderActions={() => (
          <View style={styles.inputActions}>
            {/* Add any left-side icons here if needed */}
          </View>
        )}
        renderSend={(sendProps: any) => (
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
