import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { 
  GiftedChat, 
  IMessage, 
  BubbleProps, 
  InputToolbarProps, 
  Bubble, 
  InputToolbar,
} from 'react-native-gifted-chat';
import { firestore, database, auth } from '@/src/services/firebase/initFirebase';
import { collection, query, orderBy, onSnapshot, doc } from 'firebase/firestore';
import { ref, onValue } from 'firebase/database';
import { useLocalSearchParams } from 'expo-router';
import { View, Text, ActivityIndicator, StyleSheet, TouchableOpacity, Platform, Alert, TextInput, Modal, Pressable } from 'react-native';
import { Image } from 'expo-image';
import { useAuth } from '@/src/hooks/useAuth';
import ChatHeader from '@/components/chat/ChatHeader';
import { Audio } from 'expo-av';
import * as ImagePicker from 'expo-image-picker';
import * as Clipboard from 'expo-clipboard';
import { sendMessage, uploadAndSendMedia, setTypingStatus, markChatAsRead, setChatBackground, blockUser, unblockUser, reportTarget, deleteMessage } from '@/src/services/messages/messageService';
import CallOverlay from '@/src/components/calls/CallOverlay';
import { initiateCall } from '@/src/services/calls/callService';
import RecordingWaveform from '@/src/components/messages/RecordingWaveform';
import AudioPlayer from '@/src/components/messages/AudioPlayer';
import { Ionicons } from '@expo/vector-icons';

// Import Custom SVGs
import { 
  Emoji_Icon, 
  Gallery_Icon, 
  Microphone_Icon, 
  Send_Icon, 
  Checkmark_Single, 
  Checkmark_Double,
  Search_Icon
} from '@/assets/svgs/message';

const EMOJIS = ['❤️', '🙌', '🔥', '😂', '😮', '😢', '😡', '👍'];

export default function ChatScreen() {
  const { user: firebaseUser, loading: authLoading } = useAuth();
  const { id: chatId } = useLocalSearchParams();
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
  const [isSearchVisible, setIsSearchVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [blockedStatus, setBlockedStatus] = useState<{[key: string]: boolean}>({});

  const [selectedMessage, setSelectedMessage] = useState<IMessage | null>(null);
  const [isActionModalVisible, setIsActionModalVisible] = useState(false);

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

        // --- FIX: Correct Media Mapping ---
        const isText = data.type === 'text';
        const isImage = data.type === 'image';
        const isVoice = data.type === 'voice_note';
        const isVideoMsg = data.type === 'video_message';

        return {
          _id: String(doc.id),
          // Only put actual text in 'text' field. If it's media, keep text empty unless it's a call label.
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

  const amIBlocked = useMemo(() => recipient.uid ? !!blockedStatus[recipient.uid] : false, [blockedStatus, recipient.uid]);
  const didIBlock = useMemo(() => currentUser ? !!blockedStatus[currentUser.uid] : false, [blockedStatus, currentUser]);

  const startRecording = async () => {
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
  };

  const stopRecording = async () => {
    setIsRecording(false);
    if (!recording) return;
    await recording.stopAndUnloadAsync();
    const uri = recording.getURI();
    if (uri && chatId) await uploadAndSendMedia(chatId as string, uri, 'voice_note');
    setRecording(null);
    setMeteringData([]);
  };

  const onSend = useCallback(async () => {
    if (!currentUser || !chatId || amIBlocked || didIBlock || !inputText.trim()) return;
    const text = inputText.trim();
    setInputText(''); 
    await sendMessage(chatId as string, text, 'text');
    setTypingStatus(chatId as string, false);
  }, [chatId, currentUser, amIBlocked, didIBlock, inputText]);

  const handleMsgAction = (msg: IMessage) => { setSelectedMessage(msg); setIsActionModalVisible(true); };

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
  ), [currentUser]);

  const renderMessageImage = useCallback((props: any) => {
      return (
          <View style={{ padding: 2 }}>
              <Image 
                source={{ uri: props.currentMessage.image }} 
                style={{ width: 200, height: 200, borderRadius: 15 }} 
                contentFit="cover"
                cachePolicy="memory-disk"
              />
          </View>
      );
  }, []);

  const renderDay = useCallback((props: any) => props.currentMessage?.createdAt && <View style={{ alignItems: 'center', marginVertical: 10 }}><Text style={{ color: '#9E9E9E', fontSize: 12, fontFamily: 'Urbanist-Medium' }}>{String(new Date(props.currentMessage.createdAt).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }))}</Text></View>, []);

  const renderInputToolbar = useCallback((props: InputToolbarProps<IMessage>) => {
    if (didIBlock) return <View style={styles.blockedBar}><Text style={styles.blockedText}>You blocked this user. Unblock to send messages.</Text><TouchableOpacity onPress={() => unblockUser(chatId as string, recipient.uid)}><Text style={{ color: '#FF4D67', fontWeight: 'bold', marginTop: 5 }}>Unblock</Text></TouchableOpacity></View>;
    if (amIBlocked) return <View style={styles.blockedBar}><Text style={styles.blockedText}>You cannot reply to this conversation.</Text></View>;
    return (
        <InputToolbar {...props} containerStyle={styles.inputToolbar} renderComposer={() => (
            <View style={styles.composerWrapper}>
              <TouchableOpacity style={styles.actionButton} onPress={() => setShowEmojiPicker(!showEmojiPicker)}><Emoji_Icon width={24} height={24} /></TouchableOpacity>
              <View style={styles.inputContainer}>{isRecording ? <RecordingWaveform meteringData={meteringData} /> : <TextInput style={styles.textInput} placeholder="Message..." placeholderTextColor="#9E9E9E" value={inputText} onChangeText={(t) => { setInputText(t); setTypingStatus(chatId as string, t.length > 0); }} multiline />}</View>
              <TouchableOpacity style={styles.actionButton} onPress={async () => {
                  const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.5 });
                  if (!res.canceled && res.assets[0].uri && chatId) await uploadAndSendMedia(chatId as string, res.assets[0].uri, 'image');
              }}><Gallery_Icon width={24} height={24} /></TouchableOpacity>
            </View>
          )}
          renderSend={() => (
            <TouchableOpacity onPressIn={inputText.trim() ? undefined : startRecording} onPressOut={inputText.trim() ? undefined : stopRecording} onPress={inputText.trim() ? onSend : undefined} style={[styles.micButton, isRecording && styles.micActive]}>
                {inputText.trim() ? <Send_Icon width={24} height={24} /> : (isRecording ? <View style={styles.stopIcon} /> : <Microphone_Icon width={24} height={24} />)}
            </TouchableOpacity>
          )}
        />
    );
  }, [didIBlock, amIBlocked, chatId, showEmojiPicker, inputText, isRecording, meteringData, onSend, recipient.uid]);

  if (authLoading || isLoadingMessages) return <View style={styles.centered}><ActivityIndicator size="large" color="#FF4D67" /></View>;

  return (
    <View style={{ flex: 1, backgroundColor: '#FFFFFF' }}>
      <ChatHeader recipientName={String(recipient.name)} recipientAvatar={String(recipient.avatar)} status={isTyping ? 'typing...' : String(otherUserStatus)} onAudioCall={() => !amIBlocked && !didIBlock && initiateCall(chatId as string, recipient.uid, 'audio')} onVideoCall={() => !amIBlocked && !didIBlock && initiateCall(chatId as string, recipient.uid, 'video')} onSearchPress={() => setIsSearchVisible(!isSearchVisible)} onOptionsPress={() => {}} />
      <GiftedChat messages={messages} user={{ _id: String(currentUser?.uid || '') }} renderBubble={renderBubble} renderInputToolbar={renderInputToolbar} renderMessageAudio={(p) => <View style={{ padding: 5, minWidth: 150 }}><AudioPlayer uri={p.currentMessage.audio} isSender={p.currentMessage.user._id === currentUser?.uid} /></View>} renderMessageImage={renderMessageImage} renderSystemMessage={(p) => <View style={styles.systemMessageContainer}><View style={styles.systemMessagePill}><Text style={styles.systemMessageText}>{String(p.currentMessage.text)}</Text></View></View>} renderDay={renderDay} alwaysShowSend={true} infiniteScroll renderUsernameOnMessage={false} />
      {showEmojiPicker && <View style={styles.emojiContainer}>{EMOJIS.map(e => (<TouchableOpacity key={e} onPress={() => { setInputText(prev => prev + e); setTypingStatus(chatId as string, true); }} style={styles.emojiItem}><Text style={{ fontSize: 24 }}>{e}</Text></TouchableOpacity>))}</View>}
      <Modal visible={isActionModalVisible} transparent animationType="fade" onRequestClose={() => setIsActionModalVisible(false)}><Pressable style={styles.modalOverlay} onPress={() => setIsActionModalVisible(false)}><View style={styles.modalContent}><Text style={styles.modalTitle}>Message Options</Text><TouchableOpacity style={styles.modalOption} onPress={() => { Clipboard.setStringAsync(String(selectedMessage?.text || '')); setIsActionModalVisible(false); }}><Ionicons name="copy-outline" size={24} color="#333" /><Text style={styles.modalOptionText}>Copy Text</Text></TouchableOpacity>{selectedMessage?.user._id === currentUser?.uid && (<TouchableOpacity style={[styles.modalOption, { borderBottomWidth: 0 }]} onPress={async () => { await deleteMessage(chatId as string, String(selectedMessage!._id)); setIsActionModalVisible(false); }}><Ionicons name="trash-outline" size={24} color="#FF4D67" /><Text style={[styles.modalOptionText, { color: '#FF4D67' }]}>Unsend Message</Text></TouchableOpacity>)}</View></Pressable></Modal>
      <CallOverlay chatId={chatId as string} />
    </View>
  );
}

const styles = StyleSheet.create({
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  inputToolbar: { backgroundColor: '#fff', borderTopWidth: 1, borderTopColor: '#f0f0f0', paddingHorizontal: 10, paddingVertical: 5, height: 60, justifyContent: 'center' },
  composerWrapper: { flex: 1, flexDirection: 'row', backgroundColor: '#F3F3F5', borderRadius: 25, paddingHorizontal: 10, alignItems: 'center', marginRight: 10, height: 45 },
  inputContainer: { flex: 1, height: '100%', justifyContent: 'center' },
  textInput: { fontFamily: 'Urbanist-Medium', fontSize: 16, color: '#000', paddingHorizontal: 5, ...Platform.select({ web: { outlineStyle: 'none' } }) },
  actionButton: { padding: 5 },
  micButton: { backgroundColor: '#FF4D67', width: 46, height: 46, borderRadius: 23, justifyContent: 'center', alignItems: 'center', elevation: 3 },
  micActive: { backgroundColor: '#F75555' },
  stopIcon: { width: 14, height: 14, backgroundColor: 'white', borderRadius: 2 },
  emojiContainer: { flexDirection: 'row', flexWrap: 'wrap', backgroundColor: '#fff', padding: 10, borderTopWidth: 1, borderTopColor: '#f0f0f0' },
  emojiItem: { padding: 10 },
  blockedBar: { padding: 15, alignItems: 'center', backgroundColor: '#F3F3F5', borderTopWidth: 1, borderTopColor: '#eee' },
  blockedText: { color: '#616161', fontSize: 14, fontFamily: 'Urbanist-Medium', textAlign: 'center' },
  systemMessageContainer: { alignItems: 'center', justifyContent: 'center', marginVertical: 8 },
  systemMessagePill: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F5F5F5', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 15 },
  systemMessageText: { fontSize: 12, color: '#666', fontFamily: 'Urbanist-Medium' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' },
  modalContent: { backgroundColor: 'white', width: '80%', borderRadius: 20, padding: 20 },
  modalTitle: { fontSize: 18, fontFamily: 'Urbanist-Bold', marginBottom: 20, textAlign: 'center', color: '#333' },
  modalOption: { flexDirection: 'row', alignItems: 'center', paddingVertical: 15, borderBottomWidth: 1, borderBottomColor: '#F5F5F5' },
  modalOptionText: { fontSize: 16, fontFamily: 'Urbanist-Medium', marginLeft: 15, color: '#333' },
});
