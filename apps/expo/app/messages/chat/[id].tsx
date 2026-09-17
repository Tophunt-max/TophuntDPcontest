import React, { useState, useCallback, useEffect } from 'react';
import { GiftedChat, IMessage, BubbleProps, TimeProps, InputToolbarProps, Bubble } from 'react-native-gifted-chat';
import { readApi, callApi } from '@/src/services/api';
import { live } from '@/src/services/realtime';
import { useLocalSearchParams } from 'expo-router';
import { View, Text, ActivityIndicator, StyleSheet, TouchableOpacity } from 'react-native';
import { useAuth } from '@/src/hooks/useAuth';
import ChatHeader from '@/components/chat/ChatHeader';
import { Ionicons } from '@/src/lib/icons';

const PINK = '#FF4D67';

type LoadState = 'loading' | 'ready' | 'error';

/** Map the server rows (oldest-first) to GiftedChat messages (newest-first). */
function toGiftedMessages(rows: any[]): IMessage[] {
  return (rows || [])
    .map(
      (m) =>
        ({
          _id: m.id,
          text: m.text,
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
  const params = useLocalSearchParams<{ id?: string; name?: string; avatar?: string }>();
  const chatId = params.id;

  // A single explicit state machine instead of a lone `isLoading` boolean. The
  // previous screen only ever flipped loading -> false inside the realtime
  // callback, which fires ONLY on a successful fetch — so any failure (a 500, a
  // timeout, an offline blip) left the spinner turning forever. This tracks
  // failure as a first-class state so the user gets a retry instead of a hang.
  const [state, setState] = useState<LoadState>('loading');
  // Bumping this re-runs the load effect — the "Try Again" button.
  const [reloadKey, setReloadKey] = useState(0);

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

    // Mark incoming messages as read (best-effort).
    callApi('markChatRead', { chatId }).catch(() => {});

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [chatId, currentUser, authLoading, reloadKey]);

  const onSend = useCallback(
    async (newMessages: IMessage[] = []) => {
      if (!currentUser || !chatId) return;
      // Optimistic append so the bubble appears instantly.
      setMessages((previous) => GiftedChat.append(previous, newMessages));
      const { text } = newMessages[0];
      try {
        await callApi('sendMessage', { chatId, text });
      } catch (error) {
        console.error('[ChatScreen] Error sending message:', error);
      }
    },
    [chatId, currentUser],
  );

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

  return (
    <View style={styles.screen}>
      <ChatHeader recipientName={recipientName} recipientAvatar={recipientAvatar} />
      {body()}
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
  timeText: { fontSize: 11 },
});
