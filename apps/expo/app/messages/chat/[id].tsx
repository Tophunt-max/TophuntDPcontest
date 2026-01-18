import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { 
  GiftedChat, 
  IMessage, 
  BubbleProps, 
} from 'react-native-gifted-chat';
import { firestore, database } from '@/src/services/firebase/initFirebase';
import { collection, query, orderBy, onSnapshot, doc } from 'firebase/firestore';
import { ref, onValue } from 'firebase/database';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { View, Text, ActivityIndicator, StyleSheet, TouchableOpacity, Platform, Modal, Pressable } from 'react-native';
import { Image } from 'expo-image';
import { useAuth } from '@/src/hooks/useAuth';
import ChatHeader from '@/components/chat/ChatHeader';
import { Audio } from 'expo-av';
import * as ImagePicker from 'expo-image-picker';
import * as Clipboard from 'expo-clipboard';
import { sendMessage, uploadAndSendMedia, setTypingStatus, markChatAsRead, unblockUser, deleteMessage, blockUser, reportTarget } from '@/src/services/messages/messageService';
import CallOverlay from '@/src/components/calls/CallOverlay';
import { initiateCall } from '@/src/services/calls/callService';
import AudioPlayer from '@/src/components/messages/AudioPlayer';
import { Ionicons } from '@expo/vector-icons';
import { ChatInput } from '@/src/components/messages/ChatInput';
import { ChatSearchBar } from '@/src/components/messages/ChatSearchBar';
import { ChatOptionsPopup } from '@/src/components/messages/ChatOptionsPopup';
import { MessageOptionsPopup } from '@/src/components/messages/MessageOptionsPopup';
import { Checkmark_Single, Checkmark_Double } from '@/assets/svgs/message';
import { Bubble } from 'react-native-gifted-chat';

const EMOJIS = ['❤️', '🙌', '🔥', '😂', '😮', '😢', '😡', '👍'];

export default function ChatScreen() {
  const { user: firebaseUser, loading: authLoading } = useAuth();
  const { id: chatId } = useLocalSearchParams();
  const router = useRouter();
  const [messages, setMessages] = useState<IMessage[]>([]);
  const [isLoadingMessages, setIsLoadingMessages] = useState(true);
  const [isTyping, setIsTyping] = useState(false);
  const [otherUserStatus, setOtherUserStatus] = useState<string>('offline');
  const [isRecording, setIsRecording] = useState(false);
  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const [meteringData, setMeteringData] = useState<number[]>([]);
  const [recipient, setRecipient] = useState({ name: 'User', avatar: '', uid: '' });
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [inputText, setInputText] = useState(''); 
  const [blockedStatus, setBlockedStatus] = useState<{[key: string]: boolean}>({});
  const [selectedMessage, setSelectedMessage] = useState<IMessage | null>(null);
  const [isActionModalVisible, setIsActionModalVisible] = useState(false);
  
  const [isSearchVisible, setIsSearchVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isOptionsVisible, setIsOptionsVisible] = useState(false);

  // Responsive Width for Web Popups
  const [windowWidth, setWindowWidth] = useState(typeof window !== 'undefined' ? window.innerWidth : 0);

  useEffect(() => {
    if (Platform.OS === 'web') {
        const handleResize = () => setWindowWidth(window.innerWidth);
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }
  }, []);

  const currentUser = firebaseUser;

  useEffect(() => {
    if (chatId && currentUser && messages.length > 0) markChatAsRead(chatId as string);
  }, [chatId, currentUser, messages.length]);

  useEffect(() => {
    return () => { if (chatId) setTypingStatus(chatId as string, false); };
  }, [chatId]);

  useEffect(() => {
    if (authLoading || !currentUser || !chatId) return;
    
    const chatRef = doc(firestore, 'chats', chatId as string);
    const unsubscribeChat = onSnapshot(chatRef, (snapshot) => {
        if (snapshot.exists()) {
            const data = snapshot.data();
            setBlockedStatus(data.blockedStatus || {});
            const otherUserId = data.participants.find((uid: string) => uid !== currentUser.uid);
            const otherUserData = data.participantsData?.[otherUserId] || {};
            setRecipient({ uid: String(otherUserId), name: String(otherUserData.displayName || 'User'), avatar: String(otherUserData.photoURL || ''), });
            onValue(ref(database, `presence/${otherUserId}/state`), (snap) => setOtherUserStatus(String(snap.val() || 'offline')));
            onValue(ref(database, `status/${chatId}/${otherUserId}/typing`), (snap) => setIsTyping(!!snap.val()));
        }
    });

    const messagesRef = collection(firestore, 'chats', chatId as string, 'messages');
    const q = query(messagesRef, orderBy('createdAt', 'desc'));
    const unsubscribeMessages = onSnapshot(q, (snapshot) => {
      const loadedMessages = snapshot.docs.map(doc => {
        const data = doc.data();
        const isMe = data.senderId === currentUser?.uid;
        
        let displayTitle = '';
        if (data.type === 'video_call') displayTitle = isMe ? 'Outgoing Video Call' : 'Incoming Video Call';
        else if (data.type === 'voice_call') displayTitle = isMe ? 'Outgoing Voice Call' : 'Incoming Voice Call';
        else if (data.metadata?.isMissedCall) displayTitle = isMe ? 'Cancelled Call' : 'Missed Call';

        let msgTime = data.createdAt?.toMillis ? data.createdAt.toMillis() : (data.createdAt instanceof Date ? data.createdAt.getTime() : Date.now());

        const isText = data.type === 'text';
        const isImage = data.type === 'image';
        const isVoice = data.type === 'voice_note';
        const isVideoMsg = data.type === 'video_message';

        return {
          _id: String(doc.id),
          text: displayTitle || (isText ? String(data.content || '') : ''),
          createdAt: msgTime,
          user: { _id: String(data.senderId) },
          image: isImage ? String(data.content) : undefined,
          audio: isVoice ? String(data.content) : undefined,
          video: isVideoMsg ? String(data.content) : undefined,
          system: !!displayTitle,
          received: true, sent: true, seen: data.status === 'seen'
        } as IMessage;
      });
      setMessages(loadedMessages);
      setIsLoadingMessages(false);
    });

    return () => { unsubscribeChat(); unsubscribeMessages(); };
  }, [chatId, currentUser, authLoading]);

  const filteredMessages = useMemo(() => {
    if (!searchQuery.trim()) return messages;
    return messages.filter(msg => 
      msg.text?.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [messages, searchQuery]);

  const amIBlocked = useMemo(() => recipient.uid ? !!blockedStatus[recipient.uid] : false, [blockedStatus, recipient.uid]);
  const didIBlock = useMemo(() => currentUser ? !!blockedStatus[currentUser.uid] : false, [blockedStatus, currentUser]);

  const startRecording = useCallback(async () => {
    if (amIBlocked || didIBlock) return;
    try {
      const permission = await Audio.requestPermissionsAsync();
      if (permission.status === 'granted') {
        await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
        const { recording } = await Audio.Recording.createAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
        setRecording(recording);
        setMeteringData([]);
        setIsRecording(true);
        recording.setOnRecordingStatusUpdate((s) => { if (s.metering !== undefined) setMeteringData(prev => [...prev, s.metering!]); });
        await recording.setProgressUpdateInterval(100);
      }
    } catch (err) {}
  }, [amIBlocked, didIBlock]);

  const stopRecording = useCallback(async () => {
    setIsRecording(false);
    if (!recording) return;
    await recording.stopAndUnloadAsync();
    const uri = recording.getURI();
    if (uri && chatId) await uploadAndSendMedia(chatId as string, uri, 'voice_note');
    setRecording(null);
    setMeteringData([]);
  }, [recording, chatId]);

  const onSend = useCallback(async (msgs: IMessage[] = []) => {
    const text = msgs[0]?.text;
    if (!currentUser || !chatId || amIBlocked || didIBlock || !text?.trim()) return;
    setInputText(''); 
    await sendMessage(chatId as string, text.trim(), 'text');
    setTypingStatus(chatId as string, false);
  }, [chatId, currentUser, amIBlocked, didIBlock]);

  const handleMsgAction = useCallback((msg: IMessage) => { 
    setSelectedMessage(msg); 
    setIsActionModalVisible(true); 
  }, []);

  const toggleEmojiPicker = useCallback(() => {
    setShowEmojiPicker(prev => !prev);
  }, []);

  const handleGalleryPress = useCallback(async () => {
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.5 });
    if (!res.canceled && res.assets[0].uri && chatId) {
      await uploadAndSendMedia(chatId as string, res.assets[0].uri, 'image');
    }
  }, [chatId]);

  const renderBubble = useCallback((props: BubbleProps<IMessage>) => (
    <TouchableOpacity activeOpacity={0.8} onLongPress={() => handleMsgAction(props.currentMessage!)} onPress={() => Platform.OS === 'web' && handleMsgAction(props.currentMessage!)}>
        <Bubble 
          {...props} 
          renderTime={() => null} 
          wrapperStyle={{ 
            right: { backgroundColor: '#FF4D67', borderRadius: 20, borderBottomRightRadius: 5, padding: props.currentMessage?.image ? 0 : 5, marginVertical: 4, overflow: 'hidden' }, 
            left: { backgroundColor: '#F3F3F5', borderRadius: 20, borderBottomLeftRadius: 5, padding: props.currentMessage?.image ? 0 : 5, marginVertical: 4, overflow: 'hidden' } 
          }} 
          textStyle={{ right: { color: '#fff', fontSize: 16, fontFamily: 'Urbanist-Medium' }, left: { color: '#000', fontSize: 16, fontFamily: 'Urbanist-Medium' } }} 
          renderTicks={() => props.currentMessage?.user._id === currentUser?.uid && (props.currentMessage?.seen ? <Checkmark_Double width={16} height={16} color="#34B7F1" style={{ marginLeft: 4 }} /> : <Checkmark_Single width={16} height={16} color="rgba(255,255,255,0.6)" style={{ marginLeft: 4 }} />)} 
        />
        <View style={{ paddingHorizontal: 12, paddingBottom: 5 }}><Text style={{ fontSize: 10, color: props.currentMessage?.user._id === currentUser?.uid ? 'rgba(255,255,255,0.7)' : '#9E9E9E', textAlign: props.currentMessage?.user._id === currentUser?.uid ? 'right' : 'left' }}>{String(new Date(props.currentMessage?.createdAt!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }))}</Text></View>
    </TouchableOpacity>
  ), [currentUser, handleMsgAction]);

  const renderMessageImage = useCallback((props: any) => (
      <View style={{ padding: 2 }}>
          <Image 
            source={{ uri: props.currentMessage.image }} 
            style={{ width: 200, height: 200, borderRadius: 15 }} 
            contentFit="cover"
            cachePolicy="memory-disk"
          />
      </View>
  ), []);

  const renderDay = useCallback((props: any) => props.currentMessage?.createdAt && <View style={{ alignItems: 'center', marginVertical: 10 }}><Text style={{ color: '#9E9E9E', fontSize: 12, fontFamily: 'Urbanist-Medium' }}>{String(new Date(props.currentMessage.createdAt).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }))}</Text></View>, []);

  const renderInputToolbar = useCallback((props: any) => {
    if (didIBlock) return <View style={styles.blockedBar}><Text style={styles.blockedText}>You blocked this user. Unblock to send messages.</Text><TouchableOpacity onPress={() => unblockUser(chatId as string, recipient.uid)}><Text style={{ color: '#FF4D67', fontWeight: 'bold', marginTop: 5 }}>Unblock</Text></TouchableOpacity></View>;
    if (amIBlocked) return <View style={styles.blockedBar}><Text style={styles.blockedText}>You cannot reply to this conversation.</Text></View>;
    
    return (
      <ChatInput 
        {...props}
        isRecording={isRecording}
        meteringData={meteringData}
        onEmojiPress={toggleEmojiPicker}
        onGalleryPress={handleGalleryPress}
        onMicPressIn={startRecording}
        onMicPressOut={stopRecording}
        chatId={chatId as string}
        setTypingStatus={setTypingStatus}
      />
    );
  }, [didIBlock, amIBlocked, chatId, isRecording, meteringData, toggleEmojiPicker, handleGalleryPress, startRecording, stopRecording, recipient.uid]);

  const handleBlockUser = useCallback(async () => {
    if (chatId && recipient.uid) {
        if (didIBlock) await unblockUser(chatId as string, recipient.uid);
        else await blockUser(chatId as string, recipient.uid);
    }
  }, [chatId, recipient.uid, didIBlock]);

  const handleReportUser = useCallback(async () => {
    if (recipient.uid) {
        await reportTarget('user', recipient.uid, 'Reported from Chat');
        alert("User reported successfully.");
    }
  }, [recipient.uid]);

  const handleUnsendMessage = useCallback(async () => {
    if (selectedMessage && chatId) {
        await deleteMessage(chatId as string, String(selectedMessage._id));
        setSelectedMessage(null);
    }
  }, [selectedMessage, chatId]);

  if (authLoading || isLoadingMessages) return <View style={styles.centered}><ActivityIndicator size="large" color="#FF4D67" /></View>;

  return (
    <View style={{ flex: 1, backgroundColor: '#FFFFFF' }}>
      <ChatHeader 
        recipientName={String(recipient.name)} 
        recipientAvatar={String(recipient.avatar)} 
        status={isTyping ? 'typing...' : String(otherUserStatus)} 
        onAudioCall={() => !amIBlocked && !didIBlock && initiateCall(chatId as string, recipient.uid, 'audio')} 
        onVideoCall={() => !amIBlocked && !didIBlock && initiateCall(chatId as string, recipient.uid, 'video')} 
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
        onDelete={handleUnsendMessage}
        onCopy={() => { Clipboard.setStringAsync(String(selectedMessage?.text || '')); }}
        isMyMessage={selectedMessage?.user._id === currentUser?.uid}
      />

      <GiftedChat 
          messages={messages} 
          text={inputText}
          onTextChanged={setInputText}
          onSend={onSend}
          user={{ _id: String(currentUser?.uid || '') }} 
          renderBubble={renderBubble} 
          renderInputToolbar={renderInputToolbar} 
          renderMessageAudio={(p) => <View style={{ padding: 5, minWidth: 150 }}><AudioPlayer url={p.currentMessage.audio} /></View>} 
          renderMessageImage={renderMessageImage} 
          renderSystemMessage={(p) => <View style={styles.systemMessageContainer}><View style={styles.systemMessagePill}><Text style={styles.systemMessageText}>{String(p.currentMessage.text)}</Text></View></View>} 
          renderDay={renderDay} 
          alwaysShowSend={true} 
          infiniteScroll 
          renderUsernameOnMessage={false} 
          keyboardShouldPersistTaps="handled"
      />

      {showEmojiPicker && (
        <View style={styles.emojiContainer}>
          {EMOJIS.map(e => (
            <TouchableOpacity key={e} onPress={() => { setInputText(prev => prev + e); setTypingStatus(chatId as string, true); }} style={styles.emojiItem}>
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
  systemMessageContainer: { alignItems: 'center', justifyContent: 'center', marginVertical: 8 },
  systemMessagePill: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F5F5F5', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 15 },
  systemMessageText: { fontSize: 12, color: '#666', fontFamily: 'Urbanist-Medium' },
  emojiContainer: { flexDirection: 'row', flexWrap: 'wrap', backgroundColor: '#fff', padding: 10, borderTopWidth: 1, borderTopColor: '#f0f0f0' },
  emojiItem: { padding: 10 },
});
