import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { 
  GiftedChat, 
  IMessage, 
  BubbleProps, 
} from 'react-native-gifted-chat';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { View, Text, ActivityIndicator, StyleSheet, TouchableOpacity, Platform, Modal, Pressable, Alert } from 'react-native';
import { Image } from 'expo-image';
import { useAuth } from '@/src/hooks/useAuth';
import ChatHeader from '@/components/chat/ChatHeader';
import { Audio } from 'expo-av';
import * as ImagePicker from 'expo-image-picker';
import * as Clipboard from 'expo-clipboard';
import { realtimeService, RealtimeMessage } from '@/src/services/messages/realtimeService';
import CallOverlay from '@/src/components/calls/CallOverlay';
import AudioPlayer from '@/src/components/messages/AudioPlayer';
import { Ionicons } from '@expo/vector-icons';
import { ChatInput } from '@/src/components/messages/ChatInput';
import { ChatSearchBar } from '@/src/components/messages/ChatSearchBar';
import { ChatOptionsPopup } from '@/src/components/messages/ChatOptionsPopup';
import { MessageOptionsPopup } from '@/src/components/messages/MessageOptionsPopup';
import { Checkmark_Single, Checkmark_Double } from '@/assets/svgs/message';
import { Bubble } from 'react-native-gifted-chat';

const CHAT_WORKER_API = 'https://chat.tophunt.in';
const EMOJIS = ['❤️', '🙌', '🔥', '😂', '😮', '😢', '😡', '👍'];

export default function ChatScreen() {
  const { user: currentUser, loading: authLoading } = useAuth();
  const { id: chatId } = useLocalSearchParams();
  const router = useRouter();

  // --- UI & Content State ---
  const [messages, setMessages] = useState<IMessage[]>([]);
  const [isLoadingMessages, setIsLoadingMessages] = useState(true);
  const [isTyping, setIsTyping] = useState(false);
  const [otherUserStatus, setOtherUserStatus] = useState<string>('offline');
  const [recipient, setRecipient] = useState({ name: 'User', avatar: '', uid: '' });
  const [inputText, setInputText] = useState(''); 
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [selectedMessage, setSelectedMessage] = useState<IMessage | null>(null);
  const [isActionModalVisible, setIsActionModalVisible] = useState(false);
  const [isSearchVisible, setIsSearchVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isOptionsVisible, setIsOptionsVisible] = useState(false);
  const [blockedStatus, setBlockedStatus] = useState<{[key: string]: boolean}>({});

  // --- Recording State ---
  const [isRecording, setIsRecording] = useState(false);
  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const [meteringData, setMeteringData] = useState<number[]>([]);

  // 1. Fetch History & Chat Metadata
  const fetchInitialData = useCallback(async () => {
    try {
      // Fetch Chat Metadata
      const chatListRes = await fetch(`${CHAT_WORKER_API}/chats?userId=${currentUser?.uid}`);
      const chats = await chatListRes.json();
      const currentChat = chats.find((c: any) => c.id === chatId);
      
      if (currentChat) {
          const pData = JSON.parse(currentChat.participants_data);
          const pIds = JSON.parse(currentChat.participants);
          const otherId = pIds.find((id: string) => id !== currentUser?.uid);
          const otherData = pData[otherId] || {};
          
          setRecipient({ 
            uid: String(otherId), 
            name: String(otherData.displayName || 'User'), 
            avatar: String(otherData.photoURL || ''), 
          });
          setBlockedStatus(JSON.parse(currentChat.blocked_status || '{}'));
      }

      // Fetch Message History
      const msgRes = await fetch(`${CHAT_WORKER_API}/history?chatId=${chatId}`);
      const historyData = await msgRes.json();
      
      const mappedMessages = historyData.map((msg: any) => ({
        _id: String(msg.id),
        text: msg.type === 'text' ? String(msg.content || '') : '',
        createdAt: new Date(msg.created_at),
        user: { _id: String(msg.sender_id) },
        image: msg.type === 'image' ? String(msg.content) : undefined,
        audio: msg.type === 'voice_note' ? String(msg.content) : undefined,
        received: msg.status === 'delivered' || msg.status === 'seen',
        sent: true,
        seen: msg.status === 'seen'
      })).reverse();

      setMessages(mappedMessages);
    } catch (error) {
      console.error("[ChatScreen] Error loading data:", error);
    } finally {
      setIsLoadingMessages(false);
    }
  }, [chatId, currentUser]);

  // 2. WebSocket Connection Logic
  useEffect(() => {
    if (!chatId || !currentUser) return;

    fetchInitialData();
    realtimeService.connect(chatId as string);

    const unsubscribe = realtimeService.subscribe((data: RealtimeMessage) => {
      switch (data.type) {
        case 'text':
        case 'image':
        case 'voice_note':
          if (data.from === currentUser.uid) return;
          realtimeService.send({ type: 'delivered', messageId: data.id, chatId: chatId as string });

          const newMsg: IMessage = {
            _id: data.id || Math.random().toString(),
            text: data.type === 'text' ? data.text : '',
            image: data.type === 'image' ? data.text : undefined,
            audio: data.type === 'voice_note' ? data.text : undefined,
            createdAt: data.timestamp ? new Date(data.timestamp) : new Date(),
            user: { _id: String(data.from) },
          };
          setMessages(prev => GiftedChat.append(prev, [newMsg]));
          break;

        case 'status-update':
          setMessages(prev => prev.map(m => m._id === data.messageId ? { ...m, received: true } : m));
          break;

        case 'messages-seen':
          setMessages(prev => prev.map(m => ({ ...m, seen: true, received: true })));
          break;

        case 'typing':
          if (data.from !== currentUser.uid) setIsTyping(!!data.isTyping);
          break;

        case 'presence':
          if (data.from !== currentUser.uid) setOtherUserStatus(data.status || 'offline');
          break;
      }
    });

    realtimeService.send({ type: 'mark-seen', chatId: chatId as string });

    return () => {
      unsubscribe();
      realtimeService.disconnect();
    };
  }, [chatId, currentUser, fetchInitialData]);

  // --- BLOCK & REPORT HANDLERS ---
  const handleBlockUser = async () => {
    if (chatId && currentUser) {
      const isCurrentlyBlocked = !!blockedStatus[currentUser.uid];
      try {
        const res = await fetch(`${CHAT_WORKER_API}/block`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            chatId: chatId as string, 
            userId: currentUser.uid, 
            block: !isCurrentlyBlocked 
          })
        });
        if (res.ok) {
          setBlockedStatus(prev => ({ ...prev, [currentUser.uid]: !isCurrentlyBlocked }));
          setIsOptionsVisible(false);
          Alert.alert("Success", isCurrentlyBlocked ? "User unblocked" : "User blocked");
        }
      } catch (e) {
        Alert.alert("Error", "Could not update block status");
      }
    }
  };

  const handleReportUser = async () => {
    try {
      await fetch(`${CHAT_WORKER_API}/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          chatId: chatId as string, 
          reporterId: currentUser?.uid, 
          targetId: recipient.uid 
        })
      });
      setIsOptionsVisible(false);
      Alert.alert("Success", "User reported successfully.");
    } catch (e) {
      Alert.alert("Error", "Could not send report");
    }
  };

  const amIBlocked = useMemo(() => recipient.uid ? !!blockedStatus[recipient.uid] : false, [blockedStatus, recipient.uid]);
  const didIBlock = useMemo(() => currentUser ? !!blockedStatus[currentUser.uid] : false, [blockedStatus, currentUser]);

  // 3. Messaging Handlers
  const onSend = useCallback((msgs: IMessage[] = []) => {
    if (!currentUser || !chatId || didIBlock || amIBlocked) return;
    const msg = msgs[0];
    
    realtimeService.send({
      type: 'text',
      text: msg.text,
      recipientId: recipient.uid,
      senderName: currentUser.displayName || 'User',
      chatId: chatId as string
    });

    setMessages(prev => GiftedChat.append(prev, msgs));
    setInputText('');
    realtimeService.send({ type: 'typing', isTyping: false, chatId: chatId as string });
  }, [chatId, currentUser, recipient.uid, didIBlock, amIBlocked]);

  const handleTyping = (text: string) => {
    setInputText(text);
    if (!didIBlock && !amIBlocked) {
      realtimeService.send({ 
        type: 'typing', 
        isTyping: text.length > 0, 
        chatId: chatId as string 
      });
    }
  };

  // 4. Media Handlers
  const startRecording = useCallback(async () => {
    if (didIBlock || amIBlocked) return;
    try {
      const permission = await Audio.requestPermissionsAsync();
      if (permission.status === 'granted') {
        await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
        const { recording } = await Audio.Recording.createAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
        setRecording(recording);
        setMeteringData([]);
        setIsRecording(true);
        recording.setOnRecordingStatusUpdate((s) => { if (s.metering !== undefined) setMeteringData(prev => [...prev, s.metering!]); });
      }
    } catch (err) { console.error("Recording failed", err); }
  }, [didIBlock, amIBlocked]);

  const stopRecording = useCallback(async () => {
    setIsRecording(false);
    if (!recording) return;
    await recording.stopAndUnloadAsync();
    const uri = recording.getURI();
    if (uri && chatId) {
        realtimeService.send({ 
            type: 'voice_note', 
            text: uri, 
            recipientId: recipient.uid, 
            chatId: chatId as string 
        });
    }
    setRecording(null);
  }, [recording, chatId, recipient.uid]);

  const handleGalleryPress = useCallback(async () => {
    if (didIBlock || amIBlocked) return;
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.5 });
    if (!res.canceled && res.assets[0].uri && chatId) {
        // R2 Upload and send via WS logic
    }
  }, [chatId, didIBlock, amIBlocked]);

  // 5. Custom Renders
  const renderBubble = useCallback((props: BubbleProps<IMessage>) => (
    <TouchableOpacity 
        activeOpacity={0.8} 
        onLongPress={() => { setSelectedMessage(props.currentMessage!); setIsActionModalVisible(true); }}
    >
        <Bubble 
          {...props} 
          renderTime={() => null} 
          wrapperStyle={{ 
            right: { backgroundColor: '#FF4D67', borderRadius: 20, borderBottomRightRadius: 5, padding: props.currentMessage?.image ? 0 : 5, marginVertical: 4, overflow: 'hidden' }, 
            left: { backgroundColor: '#F3F3F5', borderRadius: 20, borderBottomLeftRadius: 5, padding: props.currentMessage?.image ? 0 : 5, marginVertical: 4, overflow: 'hidden' } 
          }} 
          textStyle={{ 
            right: { color: '#fff', fontSize: 16, fontFamily: 'Urbanist-Medium' }, 
            left: { color: '#000', fontSize: 16, fontFamily: 'Urbanist-Medium' } 
          }} 
          renderTicks={() => props.currentMessage?.user._id === currentUser?.uid && (
              props.currentMessage.seen ? <Checkmark_Double width={16} height={16} color="#34B7F1" style={{ marginLeft: 4 }} /> 
              : <Checkmark_Double width={16} height={16} color="rgba(255,255,255,0.6)" style={{ marginLeft: 4 }} />
          )} 
        />
        <View style={{ paddingHorizontal: 12, paddingBottom: 5 }}>
            <Text style={{ fontSize: 10, color: props.currentMessage?.user._id === currentUser?.uid ? 'rgba(255,255,255,0.7)' : '#9E9E9E', textAlign: props.currentMessage?.user._id === currentUser?.uid ? 'right' : 'left' }}>
                {new Date(props.currentMessage?.createdAt!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}
            </Text>
        </View>
    </TouchableOpacity>
  ), [currentUser?.uid]);

  const filteredMessages = useMemo(() => {
    if (!searchQuery.trim()) return messages;
    return messages.filter(msg => msg.text?.toLowerCase().includes(searchQuery.toLowerCase()));
  }, [messages, searchQuery]);

  if (authLoading || isLoadingMessages) return <View style={styles.centered}><ActivityIndicator size="large" color="#FF4D67" /></View>;

  return (
    <View style={{ flex: 1, backgroundColor: '#FFFFFF' }}>
      <ChatHeader 
        recipientName={recipient.name} 
        recipientAvatar={recipient.avatar} 
        status={isTyping ? 'typing...' : otherUserStatus} 
        onAudioCall={() => !didIBlock && !amIBlocked && realtimeService.send({ type: 'call-request', callType: 'audio', chatId: chatId as string })} 
        onVideoCall={() => !didIBlock && !amIBlocked && realtimeService.send({ type: 'call-request', callType: 'video', chatId: chatId as string })} 
        onSearchPress={() => setIsSearchVisible(!isSearchVisible)} 
        onOptionsPress={() => setIsOptionsVisible(true)} 
      />
      
      {isSearchVisible && (
        <ChatSearchBar 
          value={searchQuery} 
          onChangeText={setSearchQuery} 
          onClose={() => { setSearchQuery(''); setIsSearchVisible(false); }} 
        />
      )}

      <ChatOptionsPopup 
        isVisible={isOptionsVisible}
        onClose={() => setIsOptionsVisible(false)}
        onBlock={handleBlockUser} 
        onReport={handleReportUser}
        onViewProfile={() => router.push(`/profile/${recipient.uid}`)}
        isBlocked={didIBlock}
      />

      <MessageOptionsPopup 
        isVisible={isActionModalVisible}
        onClose={() => setIsActionModalVisible(false)}
        onDelete={() => {}} 
        onCopy={() => { Clipboard.setStringAsync(selectedMessage?.text || ''); setIsActionModalVisible(false); }}
        isMyMessage={selectedMessage?.user._id === currentUser?.uid}
      />

      <GiftedChat 
          messages={searchQuery ? filteredMessages : messages} 
          text={inputText}
          onTextChanged={handleTyping}
          onSend={onSend}
          user={{ _id: String(currentUser?.uid || '') }} 
          renderBubble={renderBubble} 
          renderInputToolbar={(props) => {
            if (didIBlock) return <View style={styles.blockedBar}><Text style={styles.blockedText}>You blocked this user. Unblock to send messages.</Text><TouchableOpacity onPress={handleBlockUser}><Text style={{ color: '#FF4D67', fontWeight: 'bold', marginTop: 5 }}>Unblock</Text></TouchableOpacity></View>;
            if (amIBlocked) return <View style={styles.blockedBar}><Text style={styles.blockedText}>You cannot reply to this conversation.</Text></View>;

            return (
              <ChatInput 
                  {...props}
                  isRecording={isRecording}
                  meteringData={meteringData}
                  onEmojiPress={() => setShowEmojiPicker(!showEmojiPicker)}
                  onGalleryPress={handleGalleryPress}
                  onMicPressIn={startRecording}
                  onMicPressOut={stopRecording}
                  chatId={chatId as string}
                  setTypingStatus={() => {}}
              />
            );
          }} 
          renderMessageAudio={(p) => <View style={{ padding: 5, minWidth: 150 }}><AudioPlayer url={p.currentMessage!.audio!} /></View>} 
          renderMessageImage={(p) => <View style={{ padding: 2 }}><Image source={{ uri: p.currentMessage!.image }} style={{ width: 200, height: 200, borderRadius: 15 }} contentFit="cover" /></View>} 
          renderDay={(p) => p.currentMessage?.createdAt && <View style={{ alignItems: 'center', marginVertical: 10 }}><Text style={{ color: '#9E9E9E', fontSize: 12, fontFamily: 'Urbanist-Medium' }}>{new Date(p.currentMessage.createdAt).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</Text></View>} 
          alwaysShowSend 
          infiniteScroll 
          renderUsernameOnMessage={false} 
          keyboardShouldPersistTaps="handled"
      />

      {showEmojiPicker && (
        <View style={styles.emojiContainer}>
          {EMOJIS.map(e => (
            <TouchableOpacity key={e} onPress={() => { setInputText(prev => prev + e); handleTyping(inputText + e); }} style={styles.emojiItem}>
              <Text style={{ fontSize: 24 }}>{e}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
      
      <CallOverlay chatId={chatId as string} />
    </View>
  );
}

const styles = StyleSheet.create({
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  blockedBar: { padding: 15, alignItems: 'center', backgroundColor: '#F3F3F5', borderTopWidth: 1, borderTopColor: '#eee' },
  blockedText: { color: '#616161', fontSize: 14, fontFamily: 'Urbanist-Medium', textAlign: 'center' },
  emojiContainer: { flexDirection: 'row', flexWrap: 'wrap', backgroundColor: '#fff', padding: 10, borderTopWidth: 1, borderTopColor: '#f0f0f0' },
  emojiItem: { padding: 10 },
});
