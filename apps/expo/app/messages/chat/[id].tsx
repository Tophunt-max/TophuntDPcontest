import React, { useState, useCallback, useEffect, useRef } from 'react';
import { GiftedChat, IMessage, BubbleProps, TimeProps, InputToolbarProps, Bubble } from 'react-native-gifted-chat';
import * as ImagePicker from 'expo-image-picker';
import { readApi, callApi } from '@/src/services/api';
import { uploadToR2 } from '@/src/lib/uploadToR2';
import { optimizeImageForUpload } from '@/src/lib/imageOptimize';
import { live, subscribeChannel } from '@/src/services/realtime';
import { useLocalSearchParams } from 'expo-router';
import {
  View,
  Text,
  ActivityIndicator,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  FlatList,
  Keyboard,
} from 'react-native';
import { Alert } from '@/src/lib/appAlert';
import { useAuth } from '@/src/hooks/useAuth';
import ChatHeader from '@/components/chat/ChatHeader';
import { Ionicons } from '@/src/lib/icons';
import { CloseIcon } from '@/src/components/ui/CloseIcon';

const PINK = '#FF4D67';

type LoadState = 'loading' | 'ready' | 'error';

/** Map the server rows (oldest-first) to GiftedChat messages (newest-first). */
function toGiftedMessages(rows: any[]): IMessage[] {
  return (rows || [])
    .map(
      (m) =>
        ({
          _id: m.id,
          // An image message may carry only a caption (or nothing); GiftedChat
          // renders `image` above `text`, so both flow through the same bubble.
          text: m.text || '',
          image: m.type === 'image' && m.mediaUrl ? m.mediaUrl : undefined,
          createdAt: new Date(m.createdAt),
          user: { _id: m.senderId },
          sent: true,
          received: !!m.read,
        } as IMessage),
    )
    .reverse();
}

export default function ChatScreen() {
  const { user: firebaseUser, loading: authLoading } = useAuth();
  const [messages, setMessages] = useState<IMessage[]>([]);
  const params = useLocalSearchParams<{ id?: string; name?: string; avatar?: string; lastSeen?: string }>();
  const chatId = params.id;

  // A single explicit state machine instead of a lone `isLoading` boolean. The
  // previous screen only ever flipped loading -> false inside the realtime
  // callback, which fires ONLY on a successful fetch — so any failure (a 500, a
  // timeout, an offline blip) left the spinner turning forever. This tracks
  // failure as a first-class state so the user gets a retry instead of a hang.
  const [state, setState] = useState<LoadState>('loading');
  // Bumping this re-runs the load effect — the "Try Again" button.
  const [reloadKey, setReloadKey] = useState(0);

  // "…is typing" presence. Driven by ephemeral `typing` events on the chat
  // channel; auto-clears if no keystroke arrives for a few seconds so a dropped
  // "stopped typing" signal can never leave the indicator stuck on.
  const [otherTyping, setOtherTyping] = useState(false);
  const typingClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTypingSent = useRef(0);

  // Live presence of the other member. `online` flips on realtime `presence`
  // events on this chat channel; `lastSeen` is seeded from the value the inbox
  // passed through (so the header shows "last seen …" on first paint) and then
  // kept fresh by the same events.
  const [otherOnline, setOtherOnline] = useState(false);
  const [otherLastSeen, setOtherLastSeen] = useState<number | null>(
    params.lastSeen ? Number(params.lastSeen) || null : null,
  );

  // Uploading state for an image message (blocks a second pick mid-upload).
  const [uploadingImage, setUploadingImage] = useState(false);

  // In-conversation message search.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[] | null>(null);
  const [searching, setSearching] = useState(false);

  // Recipient identity is passed as query params by whoever opened the chat
  // (the chat list and the profile "Message" button both already know the other
  // user). Falls back to a neutral label for a cold deep-link.
  const recipientName = params.name || 'Chat';
  const recipientAvatar = params.avatar || null;

  const currentUser = firebaseUser;

  useEffect(() => {
    if (authLoading) return;
    if (!currentUser || !chatId) {
      setState('error');
      return;
    }

    let cancelled = false;
    setState('loading');

    // 1) INITIAL LOAD — explicit, with real error handling. This is what fixes
    //    the infinite spinner: a failed first fetch flips us to the error state
    //    (retryable) rather than leaving `loading` stuck true.
    (async () => {
      try {
        const rows = await readApi(`/read/chats/${chatId}/messages`);
        if (cancelled) return;
        setMessages(toGiftedMessages(rows));
        setState('ready');
      } catch {
        if (!cancelled) setState('error');
      }
    })();

    // 2) REALTIME UPDATES — the socket pushes new messages; `immediate: false`
    //    skips its own initial fetch since (1) already did it. A successful
    //    background refresh also clears a transient error, so the screen
    //    self-heals the moment connectivity returns.
    const unsubscribe = live<any[]>(
      `chat:${chatId}`,
      () => readApi(`/read/chats/${chatId}/messages`),
      (rows) => {
        if (cancelled) return;
        setMessages(toGiftedMessages(rows));
        setState('ready');
      },
      { filter: (e) => e.type === 'message', immediate: false },
    );

    // 3) TYPING + PRESENCE — a separate raw subscription on the same channel,
    //    since `live()` above only forwards `message` events. Both signals name
    //    the other member (a DM has exactly two), so anything not from us is
    //    "them". Ignore our own echo.
    const unsubAux = subscribeChannel(`chat:${chatId}`, (e) => {
      if (cancelled || e.uid === currentUser.uid) return;
      if (e.type === 'typing') {
        setOtherTyping(true);
        if (typingClearTimer.current) clearTimeout(typingClearTimer.current);
        typingClearTimer.current = setTimeout(() => setOtherTyping(false), 4000);
      } else if (e.type === 'presence') {
        setOtherOnline(!!e.online);
        if (typeof e.lastSeen === 'number') setOtherLastSeen(e.lastSeen);
        // Coming online also means they are no longer "typing" from a stale signal.
        if (e.online === false) setOtherTyping(false);
      }
    });

    // Mark incoming messages as read (best-effort).
    callApi('markChatRead', { chatId }).catch(() => {});

    return () => {
      cancelled = true;
      unsubscribe();
      unsubAux();
      if (typingClearTimer.current) clearTimeout(typingClearTimer.current);
    };
  }, [chatId, currentUser, authLoading, reloadKey]);

  // Tell the other member we're typing — throttled to at most once per ~2.5s so a
  // fast typist doesn't fan out a broadcast per keystroke. Best-effort.
  const onInputTextChanged = useCallback(
    (text: string) => {
      if (!chatId || !text.trim()) return;
      const now = Date.now();
      if (now - lastTypingSent.current < 2500) return;
      lastTypingSent.current = now;
      callApi('setTyping', { chatId }).catch(() => {});
    },
    [chatId],
  );

  /**
   * Send a text message.
   *
   * The optimistic bubble is appended immediately, then REMOVED again if the send
   * fails, and the user is told.
   *
   * Previously the failure was written to `console.error` and nowhere else: the
   * bubble stayed on screen looking exactly like a delivered message, so the user
   * closed the app believing it had been sent. Worse, the bubble then vanished
   * without explanation the moment the realtime callback replaced `messages`
   * wholesale (which happens as soon as either party sends anything) — silent data
   * loss behind a UI that actively signalled success. The sibling `onPickImage`
   * already alerted on failure; this now matches it.
   */
  const onSend = useCallback(
    async (newMessages: IMessage[] = []) => {
      if (!currentUser || !chatId) return;
      const outgoing = newMessages[0];
      if (!outgoing) return;
      // Optimistic append so the bubble appears instantly.
      setMessages((previous) => GiftedChat.append(previous, newMessages));
      try {
        await callApi('sendMessage', { chatId, text: outgoing.text });
      } catch (error) {
        console.error('[ChatScreen] Error sending message:', error);
        // Take the bubble back so the conversation reflects what was actually
        // delivered, and hand the text back in the alert so it is not lost.
        setMessages((previous) => previous.filter((m) => m._id !== outgoing._id));
        Alert.alert(
          'Message not sent',
          'We could not send that message. Check your connection and try again.',
        );
      }
    },
    [chatId, currentUser],
  );

  // Pick an image, downscale it, upload to the `chat/` R2 folder, then send it as
  // an image message. The bubble appears optimistically from the LOCAL uri and is
  // replaced by the server copy on the next realtime refresh.
  const onPickImage = useCallback(async () => {
    if (!currentUser || !chatId || uploadingImage) return;
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Permission needed', 'Allow photo access to send an image.');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.9 });
      if (result.canceled || !result.assets?.length) return;
      const localUri = result.assets[0].uri;

      setUploadingImage(true);
      // Optimistic bubble from the local file.
      const tempId = `local-${Date.now()}`;
      setMessages((prev) =>
        GiftedChat.append(prev, [
          {
            _id: tempId,
            text: '',
            image: localUri,
            createdAt: new Date(),
            user: { _id: currentUser.uid },
            pending: true,
          } as IMessage,
        ]),
      );

      const optimized = await optimizeImageForUpload(localUri, 'contest');
      const mediaUrl = await uploadToR2(optimized, 'image/jpeg', 'chat');
      await callApi('sendMessage', { chatId, mediaUrl });
      // The live `message` refresh will bring back the server copy; the optimistic
      // bubble is harmless until then (same image, from the local uri).
    } catch (error) {
      console.error('[ChatScreen] Error sending image:', error);
      Alert.alert('Upload failed', 'Could not send that image. Please try again.');
    } finally {
      setUploadingImage(false);
    }
  }, [chatId, currentUser, uploadingImage]);

  // Run an in-conversation message search against the per-chat endpoint.
  const runSearch = useCallback(
    async (q: string) => {
      const query = q.trim();
      if (!chatId || !query) {
        setSearchResults(null);
        return;
      }
      setSearching(true);
      try {
        const rows = await readApi(`/read/chats/${chatId}/messages/search?q=${encodeURIComponent(query)}`);
        setSearchResults(Array.isArray(rows) ? rows : []);
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    },
    [chatId],
  );

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery('');
    setSearchResults(null);
    Keyboard.dismiss();
  }, []);

  const renderBubble = (props: BubbleProps<IMessage>) => (
    <Bubble
      {...props}
      wrapperStyle={{
        left: { backgroundColor: '#F1F1F4', borderRadius: 18, borderBottomLeftRadius: 5, marginBottom: 2 },
        right: { backgroundColor: PINK, borderRadius: 18, borderBottomRightRadius: 5, marginBottom: 2 },
      }}
      textStyle={{
        left: { color: '#1A1A1A', fontSize: 15, lineHeight: 21 },
        right: { color: '#FFFFFF', fontSize: 15, lineHeight: 21 },
      }}
    />
  );

  const renderTime = (props: TimeProps<IMessage>) => {
    const isCurrentUser = props.currentMessage?.user._id === currentUser?.uid;
    return (
      <View style={{ paddingHorizontal: 10, paddingBottom: 4 }}>
        <Text style={[styles.timeText, { color: isCurrentUser ? 'rgba(255,255,255,0.75)' : '#9AA0A6' }]}>
          {props.currentMessage?.createdAt
            ? new Date(props.currentMessage.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : ''}
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
          <TouchableOpacity
            onPress={onPickImage}
            disabled={uploadingImage}
            style={styles.attachButton}
            accessibilityLabel="Send a photo"
          >
            {uploadingImage ? (
              <ActivityIndicator size="small" color={PINK} />
            ) : (
              <Ionicons name="image-outline" size={24} color={PINK} />
            )}
          </TouchableOpacity>
        )}
        renderSend={(sendProps: any) => (
          <TouchableOpacity
            onPress={sendProps.onSend}
            disabled={!sendProps.text?.trim()}
            style={[styles.sendButton, !sendProps.text?.trim() && styles.sendButtonDisabled]}
          >
            <Ionicons name="send" size={19} color="white" />
          </TouchableOpacity>
        )}
        textInputStyle={styles.textInput}
        placeholder="Type a message…"
      />
    </View>
  );

  // ---- Non-chat states (header stays so the user can always go back) ----
  const body = () => {
    if (authLoading || (state === 'loading' && !messages.length)) {
      return (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={PINK} />
          <Text style={styles.mutedText}>Loading messages…</Text>
        </View>
      );
    }
    if (!currentUser) {
      return (
        <View style={styles.centered}>
          <Ionicons name="lock-closed-outline" size={40} color="#C9CDD2" />
          <Text style={styles.stateTitle}>Please log in</Text>
          <Text style={styles.mutedText}>Sign in to view this conversation.</Text>
        </View>
      );
    }
    if (!chatId) {
      return (
        <View style={styles.centered}>
          <Ionicons name="chatbubbles-outline" size={40} color="#C9CDD2" />
          <Text style={styles.stateTitle}>No chat selected</Text>
          <Text style={styles.mutedText}>Go back and pick a conversation.</Text>
        </View>
      );
    }
    if (state === 'error' && !messages.length) {
      return (
        <View style={styles.centered}>
          <View style={styles.errorIconCircle}>
            <Ionicons name="cloud-offline-outline" size={34} color={PINK} />
          </View>
          <Text style={styles.stateTitle}>Couldn’t load messages</Text>
          <Text style={styles.mutedText}>Check your connection and try again.</Text>
          <TouchableOpacity style={styles.retryButton} onPress={() => setReloadKey((k) => k + 1)} activeOpacity={0.85}>
            <Ionicons name="refresh" size={17} color="white" style={{ marginRight: 8 }} />
            <Text style={styles.retryText}>Try Again</Text>
          </TouchableOpacity>
        </View>
      );
    }

    return (
      <GiftedChat
        messages={messages}
        onSend={(m) => onSend(m)}
        user={{ _id: currentUser.uid }}
        renderBubble={renderBubble}
        renderTime={renderTime}
        renderInputToolbar={renderInputToolbar}
        minInputToolbarHeight={64}
        // Hook keystrokes via textInputProps.onChangeText (this GiftedChat version
        // has no onInputTextChanged prop). It rides alongside the Composer's own
        // onChange, so it never clobbers the input's text handling.
        textInputProps={{ onChangeText: onInputTextChanged }}
        renderFooter={() =>
          otherTyping ? (
            <View style={styles.typingRow}>
              <View style={styles.typingBubble}>
                <Text style={styles.typingText}>{recipientName.split(' ')[0]} is typing…</Text>
              </View>
            </View>
          ) : null
        }
        renderChatEmpty={() => (
          <View style={styles.emptyChat}>
            {/* GiftedChat's empty container is inverted, so flip it upright. */}
            <View style={{ transform: [{ scaleY: -1 }], alignItems: 'center' }}>
              <View style={styles.emptyIconCircle}>
                <Ionicons name="chatbubble-ellipses-outline" size={36} color={PINK} />
              </View>
              <Text style={styles.stateTitle}>Say hello 👋</Text>
              <Text style={styles.mutedText}>No messages yet — start the conversation.</Text>
            </View>
          </View>
        )}
      />
    );
  };

  // In-conversation search view — replaces the thread while open, restores it on
  // Cancel. Media messages carry no text so they never match; results are
  // newest-first from the per-chat search endpoint.
  const searchPanel = () => (
    <View style={styles.searchPanel}>
      <View style={styles.searchBarRow}>
        <View style={styles.searchInputWrap}>
          <Ionicons name="search" size={18} color="#9AA0A6" />
          <TextInput
            style={styles.searchFieldInput}
            placeholder="Search messages…"
            placeholderTextColor="#9AA0A6"
            autoFocus
            value={searchQuery}
            onChangeText={setSearchQuery}
            onSubmitEditing={() => runSearch(searchQuery)}
            returnKeyType="search"
          />
          {searchQuery ? (
            <TouchableOpacity
              onPress={() => {
                setSearchQuery('');
                setSearchResults(null);
              }}
            >
              <CloseIcon variant="circle" size={18} color="#C9CDD2" />
            </TouchableOpacity>
          ) : null}
        </View>
        <TouchableOpacity onPress={closeSearch}>
          <Text style={styles.searchCancel}>Cancel</Text>
        </TouchableOpacity>
      </View>

      {searching ? (
        <View style={styles.centered}>
          <ActivityIndicator color={PINK} />
        </View>
      ) : searchResults === null ? (
        <View style={styles.searchHint}>
          <Ionicons name="search-outline" size={34} color="#C9CDD2" />
          <Text style={styles.mutedText}>Search this conversation’s messages.</Text>
        </View>
      ) : searchResults.length === 0 ? (
        <View style={styles.searchHint}>
          <Ionicons name="sad-outline" size={34} color="#C9CDD2" />
          <Text style={styles.mutedText}>No messages found for “{searchQuery.trim()}”.</Text>
        </View>
      ) : (
        <FlatList
          data={searchResults}
          keyExtractor={(m) => m.id}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingVertical: 8 }}
          renderItem={({ item }) => {
            const mine = item.senderId === currentUser?.uid;
            return (
              <View style={styles.searchResultItem}>
                <Text style={styles.searchResultWho}>{mine ? 'You' : recipientName.split(' ')[0]}</Text>
                <Text style={styles.searchResultText} numberOfLines={3}>
                  {item.text}
                </Text>
                <Text style={styles.searchResultTime}>
                  {new Date(item.createdAt).toLocaleString([], {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </Text>
              </View>
            );
          }}
        />
      )}
    </View>
  );

  return (
    <View style={styles.screen}>
      <ChatHeader
        recipientName={recipientName}
        recipientAvatar={recipientAvatar}
        online={otherOnline}
        lastSeen={otherLastSeen}
        onSearchPress={() => setSearchOpen((v) => !v)}
      />
      {searchOpen ? searchPanel() : body()}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#FFFFFF' },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
    backgroundColor: '#FFFFFF',
  },
  stateTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1A1A1A',
    marginTop: 14,
    textAlign: 'center',
  },
  mutedText: {
    fontSize: 14,
    color: '#9AA0A6',
    marginTop: 6,
    textAlign: 'center',
    lineHeight: 20,
  },
  errorIconCircle: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: 'rgba(255,77,103,0.10)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyIconCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: 'rgba(255,77,103,0.10)',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 4,
  },
  retryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: PINK,
    paddingHorizontal: 28,
    paddingVertical: 13,
    borderRadius: 26,
    marginTop: 22,
    shadowColor: PINK,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  retryText: { color: 'white', fontSize: 15, fontWeight: '700' },
  emptyChat: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 80,
    paddingHorizontal: 32,
  },
  inputToolbarContainer: {
    backgroundColor: '#FFFFFF',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#ECECEC',
  },
  inputToolbar: {
    backgroundColor: '#F4F4F6',
    borderRadius: 26,
    marginHorizontal: 0,
    marginBottom: 2,
    borderWidth: 0,
    paddingHorizontal: 8,
    minHeight: 48,
    justifyContent: 'center',
  },
  textInput: {
    flex: 1,
    fontSize: 15,
    lineHeight: 21,
    color: '#1A1A1A',
    marginLeft: 8,
    marginTop: 0,
    marginBottom: 0,
    paddingTop: 0,
  },
  sendButton: {
    backgroundColor: PINK,
    borderRadius: 20,
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 4,
    marginBottom: 4,
  },
  sendButtonDisabled: { backgroundColor: '#F3A6B2' },
  attachButton: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 4,
    marginBottom: 4,
  },
  timeText: { fontSize: 11 },
  searchPanel: { flex: 1, backgroundColor: '#FFFFFF' },
  searchBarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ECECEC',
  },
  searchInputWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F4F4F6',
    borderRadius: 22,
    paddingHorizontal: 14,
    height: 44,
  },
  searchFieldInput: {
    flex: 1,
    fontSize: 15,
    color: '#1A1A1A',
    marginLeft: 8,
  },
  searchCancel: { color: PINK, fontSize: 15, fontWeight: '600', marginLeft: 12 },
  searchHint: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 32 },
  searchResultItem: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#F1F1F4',
  },
  searchResultWho: { fontSize: 12, fontWeight: '700', color: PINK, marginBottom: 2 },
  searchResultText: { fontSize: 15, color: '#1A1A1A', lineHeight: 20 },
  searchResultTime: { fontSize: 11, color: '#9AA0A6', marginTop: 4 },
  typingRow: {
    paddingHorizontal: 14,
    paddingBottom: 8,
    paddingTop: 2,
    alignItems: 'flex-start',
  },
  typingBubble: {
    backgroundColor: '#F1F1F4',
    borderRadius: 16,
    borderBottomLeftRadius: 5,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  typingText: { fontSize: 13, color: '#8A8F98', fontStyle: 'italic' },
});
