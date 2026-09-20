import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  TextInput,
  ScrollView,
  Platform,
  Keyboard,
  Animated,
  RefreshControl,
} from "react-native";
import { Alert } from '@/src/lib/appAlert';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { emitToast } from '@/src/lib/toastBridge';
import { reportError } from '@/src/lib/reportError';
import { auth } from '@/src/services/firebase/initFirebase';
import { readApi, callApi } from '@/src/services/api';
import { live, subscribeChannel } from '@/src/services/realtime';
import { useRouter } from 'expo-router';
import { useThemeColor } from '@/hooks/use-theme-color';
import { ThemedView } from '@/components/themed-view';
import { MessageSkeleton } from '@/src/components/messages/MessageSkeleton';
import { Swipeable } from 'react-native-gesture-handler';
import { Colors } from '@/constants/theme';
import { Avatar } from '@/src/components/ui/Avatar';
import { VerifiedBadge } from '@/src/components/ui/VerifiedBadge';
import { LinearGradient } from 'expo-linear-gradient';

// Instagram-style story ring gradient (warm yellow -> pink -> purple).
const STORY_RING = ['#FEDA75', '#FA7E1E', '#D62976', '#962FBF', '#4F5BD5'] as const;

// Import Icons from assets
import { 
  Add_Icon, 
  Menu_Light, 
  Menu_Dark, 
  Search_Light, 
  Search_Dark, 
  Control,
  Delete_Icon,
  Inbox_Light,
  Inbox_Dark
} from '@/assets/svgs';
import { BackButton } from '@/src/components/ui/BackButton';

// --- TYPES ---
interface UserData {
  uid: string;
  displayName: string;
  photoURL: string;
  isOnline?: boolean;
  /** Epoch ms of last connect/disconnect, from /read/chats enrichment. */
  lastSeen?: number | null;
  /** Live-stamped admin blue check (see worker /read/chats enrichment). */
  verified?: boolean;
}

/** Live presence keyed by uid, driven by realtime `presence` events. */
type PresenceMap = Record<string, { online: boolean; lastSeen: number | null }>;

interface ChatItemType {
  id: string;
  users: string[];
  usersData?: UserData[];
  lastMessage?: {
    text: string;
    createdAt: any;
  };
  unreadCount?: number;
}

/**
 * Build the chat route, carrying the recipient's identity along.
 *
 * The chat screen has no endpoint to resolve a single chat, so it used to render
 * a hardcoded "John Doe" and an `i.pravatar.cc` avatar. Both call sites here
 * already know the real other user, so pass it through instead.
 */
function chatRoute(
  chatId: string,
  name?: string | null,
  avatar?: string | null,
  lastSeen?: number | null,
): string {
  const qs = new URLSearchParams();
  if (name) qs.set('name', name);
  if (avatar) qs.set('avatar', avatar);
  // Seed the chat header's "last seen" text before any realtime event arrives.
  if (lastSeen) qs.set('lastSeen', String(lastSeen));
  const query = qs.toString();
  return `/messages/chat/${chatId}${query ? `?${query}` : ''}`;
}

export default function MessagesScreen() {
  const [chats, setChats] = useState<ChatItemType[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const [presence, setPresence] = useState<PresenceMap>({});

  const currentUser = auth.currentUser;

  // Live presence for everyone in the inbox. `presence` events arrive on the
  // user's OWN channel (a peer's connect/disconnect fans out to their chat
  // partners), so one subscription keeps every green dot live without opening a
  // socket per conversation.
  useEffect(() => {
    if (!currentUser) return;
    const unsub = subscribeChannel(`user:${currentUser.uid}`, (e) => {
      if (e.type !== 'presence' || !e.uid) return;
      setPresence((prev) => ({
        ...prev,
        [e.uid]: {
          online: !!e.online,
          lastSeen: typeof e.lastSeen === 'number' ? e.lastSeen : prev[e.uid]?.lastSeen ?? null,
        },
      }));
    });
    return unsub;
  }, [currentUser]);
  const router = useRouter();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;
  const textColor = isDark ? Colors.dark.text : Colors.light.text;
  
  const pinkPrimary = '#FF4D67';
  const focusAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(focusAnim, {
      toValue: isFocused ? 1 : 0,
      duration: 250,
      useNativeDriver: false,
    }).start();
  }, [isFocused]);

  // Instagram's search field is a plain rounded gray pill; focus just deepens
  // the fill slightly rather than flashing a coloured border.
  const interpolatedBackgroundColor = focusAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [isDark ? '#1C1C1E' : '#EFEFEF', isDark ? '#2A2A2C' : '#E4E4E4'],
  });

  const interpolatedBorderColor = focusAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['transparent', 'transparent'],
  });

  const fetchChats = useCallback(() => {
    if (!currentUser) {
      setLoading(false);
      setRefreshing(false);
      return;
    }

    // Instant push via the user's WebSocket channel (chat-list bumps).
    const unsubscribe = live<ChatItemType[]>(
      `user:${currentUser.uid}`,
      () => readApi('/read/chats'),
      (chatsData) => {
        setChats(chatsData || []);
        setLoading(false);
        setRefreshing(false);
      },
      { filter: (e) => e.type === 'chat_update' },
    );

    return unsubscribe;
  }, [currentUser]);

  useEffect(() => {
    const unsubscribe = fetchChats();
    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [fetchChats]);

  // Pull-to-refresh does a ONE-OFF GET, not fetchChats(). fetchChats() opens a
  // fresh live() subscription (a WebSocket listener + a safety-net poll) and
  // returns an unsubscribe — but here that unsubscribe was discarded, so every
  // pull leaked another subscription and stacked another chat-list callback on
  // top of the previous ones. The persistent subscription created in the mount
  // effect already keeps the inbox live; a manual refresh only needs to re-pull
  // the list once.
  const onRefresh = useCallback(async () => {
    if (!currentUser) {
      setRefreshing(false);
      return;
    }
    setRefreshing(true);
    try {
      const chatsData = await readApi('/read/chats');
      setChats(chatsData || []);
    } catch (e) {
      reportError(e, { screen: 'messages', action: 'refresh' });
      emitToast('Could not refresh your chats.', 'error');
    } finally {
      setRefreshing(false);
    }
  }, [currentUser]);

  const handleDeleteChat = (chatId: string) => {
    Alert.alert(
      "Delete Chat",
      "Are you sure you want to delete this chat?",
      [
        { text: "Cancel", style: "cancel" },
        { 
          text: "Delete", 
          style: "destructive", 
          onPress: async () => {
            try {
              await callApi('deleteChat', { chatId });
              setChats((prev) => prev.filter((c) => c.id !== chatId));
            } catch (error) {
              console.error("Error deleting chat:", error);
            }
          } 
        }
      ]
    );
  };

  const filteredChats = useMemo(() => {
    if (!searchText) return chats;
    const q = searchText.toLowerCase();
    // Match either the other person's name OR the last message preview, so the
    // inbox search finds conversations by who they're with AND by what was said.
    return chats.filter(chat => {
      const otherUser = chat.usersData?.find(u => u.uid !== currentUser?.uid);
      const name = otherUser?.displayName?.toLowerCase() || '';
      const preview = chat.lastMessage?.text?.toLowerCase() || '';
      return name.includes(q) || preview.includes(q);
    });
  }, [chats, searchText, currentUser]);

  const formatTime = (timestamp: any) => {
    if (!timestamp) return '';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const oneDay = 24 * 60 * 60 * 1000;

    if (diff < oneDay && now.getDate() === date.getDate()) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    } else if (diff < oneDay * 2) {
      return 'Yesterday';
    } else {
      return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }
  };

  const renderRecentlyItem = useCallback((item: ChatItemType) => {
    const otherUser = item.usersData?.find((u: any) => u.uid !== currentUser?.uid);
    const name = otherUser?.displayName || 'User';
    const avatar = otherUser?.photoURL;
    const id = item.id;
    const lastSeen = (otherUser?.uid ? presence[otherUser.uid]?.lastSeen : null) ?? otherUser?.lastSeen ?? null;
    const isOnline = (otherUser?.uid ? presence[otherUser.uid]?.online : false) ?? false;

    return (
      <View key={id} style={styles.recentlyItem}>
        <TouchableOpacity activeOpacity={0.8} onPress={() => router.push(chatRoute(id, name, avatar, lastSeen))}>
          <LinearGradient
            colors={STORY_RING}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.storyRing}
          >
            <View style={[styles.storyInner, { backgroundColor }]}>
              <Avatar uri={avatar} name={name} size={56} />
            </View>
          </LinearGradient>
          {isOnline && <View style={[styles.onlineIndicator, { borderColor: backgroundColor }]} />}
        </TouchableOpacity>
        <Text style={[styles.recentlyName, { color: textColor }]} numberOfLines={1}>
          {name.split(' ')[0]}
        </Text>
      </View>
    );
  }, [currentUser, router, textColor, backgroundColor, presence]);

  const renderRightActions = (chatId: string) => (
    <TouchableOpacity
      onPress={() => handleDeleteChat(chatId)}
      style={styles.deleteAction}
    >
      <Delete_Icon width={24} height={24} />
      <Text style={styles.deleteText}>Delete</Text>
    </TouchableOpacity>
  );

  const renderChatItem = useCallback(({ item }: { item: ChatItemType }) => {
    const otherUser = item.usersData?.find((u: any) => u.uid !== currentUser?.uid);
    const time = formatTime(item.lastMessage?.createdAt);
    const unreadCount = item.unreadCount || 0;
    const hasUnread = unreadCount > 0;
    const lastSeen = (otherUser?.uid ? presence[otherUser.uid]?.lastSeen : null) ?? otherUser?.lastSeen ?? null;
    const isOnline = (otherUser?.uid ? presence[otherUser.uid]?.online : false) ?? false;
    const mutedColor = isDark ? '#8A8F98' : '#9AA0A6';

    return (
      <Swipeable
        renderRightActions={() => renderRightActions(item.id)}
        friction={2}
        rightThreshold={40}
      >
        <TouchableOpacity
          activeOpacity={0.7}
          style={[styles.chatItem, { backgroundColor: backgroundColor }]}
          onPress={() =>
            router.push(
              chatRoute(
                item.id,
                otherUser?.displayName || 'User',
                otherUser?.photoURL,
                lastSeen,
              ),
            )
          }
        >
          <View>
            <Avatar
              uri={otherUser?.photoURL}
              name={otherUser?.displayName}
              size={58}
              style={styles.chatAvatar}
            />
            {isOnline && <View style={[styles.onlineIndicator, styles.chatOnlineIndicator, { borderColor: backgroundColor }]} />}
          </View>

          <View style={styles.chatInfo}>
            <View style={styles.nameRow}>
              <Text
                style={[styles.userName, { color: textColor }, hasUnread && styles.userNameUnread]}
                numberOfLines={1}
              >
                {otherUser?.displayName || 'User'}
              </Text>
              <VerifiedBadge verified={(otherUser as any)?.verified} size={14} />
            </View>

            <View style={styles.previewRow}>
              <Text
                style={[
                  styles.lastMessage,
                  { color: mutedColor },
                  hasUnread && [styles.lastMessageUnread, { color: textColor }],
                ]}
                numberOfLines={1}
              >
                {item.lastMessage?.text || 'No messages yet'}
              </Text>
              {time ? (
                <Text style={[styles.previewTime, { color: mutedColor }]} numberOfLines={1}>
                  {'  ·  '}{time}
                </Text>
              ) : null}
            </View>
          </View>

          {/* Instagram shows a solid dot for unread threads rather than a count. */}
          {hasUnread ? <View style={styles.unreadDot} /> : null}
        </TouchableOpacity>
      </Swipeable>
    );
  }, [currentUser, router, textColor, backgroundColor, presence, isDark]);

  const listHeaderComponent = useMemo(() => {
    const recentlyData = chats.slice(0, 8);

    return (
      <View style={styles.headerContainer}>
        {/* Animated Search Bar */}
        <Animated.View style={[
          styles.searchSection, 
          { 
            backgroundColor: interpolatedBackgroundColor,
            borderColor: interpolatedBorderColor,
            borderWidth: 0,
          }
        ]}>
          <View style={styles.searchIconContainer}>
             {isDark ? <Search_Dark width={20} height={20} /> : <Search_Light width={20} height={20} />}
          </View>
          <TextInput
            style={[styles.searchInput, { color: textColor }]}
            placeholder="Search"
            placeholderTextColor="#9E9E9E"
            value={searchText}
            onChangeText={setSearchText}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            returnKeyType="search"
            onSubmitEditing={() => Keyboard.dismiss()}
          />
          <TouchableOpacity>
             <Control width={20} height={20} fill={pinkPrimary} />
          </TouchableOpacity>
        </Animated.View>

        {/* Recently Section - Only show if there are chats */}
        {recentlyData.length > 0 && (
          <>
            <View style={styles.sectionHeader}>
              <Text style={[styles.sectionTitle, { color: textColor }]}>Recently</Text>
            </View>
            <ScrollView 
              horizontal 
              showsHorizontalScrollIndicator={false} 
              contentContainerStyle={styles.recentlyList}
              keyboardShouldPersistTaps="handled"
            >
              {recentlyData.map(renderRecentlyItem)}
            </ScrollView>
          </>
        )}

        {/* Message Heading */}
        {chats.length > 0 && (
          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionTitle, { color: textColor }]}>Message</Text>
          </View>
        )}
      </View>
    );
  }, [isFocused, searchText, textColor, chats, renderRecentlyItem, isDark, interpolatedBackgroundColor, interpolatedBorderColor]);

  const EmptyState = () => {
    const isSearching = searchText.length > 0;
    
    return (
      <View style={styles.emptyContainer}>
        <View style={styles.emptyIconCircle}>
            {isDark ? (
                isSearching ? <Search_Dark width={60} height={60} /> : <Inbox_Dark width={60} height={60} />
            ) : (
                isSearching ? <Search_Light width={60} height={60} /> : <Inbox_Light width={60} height={60} />
            )}
        </View>
        <Text style={[styles.emptyTitle, { color: textColor }]}>
            {isSearching ? 'No results found' : 'No messages yet'}
        </Text>
        <Text style={styles.emptySubtitle}>
            {isSearching 
                ? `We couldn't find any chats matching "${searchText}"`
                : "You haven't started any conversations yet. Start chatting with your friends!"}
        </Text>
        {!isSearching && (
            <TouchableOpacity style={styles.startChatButton} onPress={() => router.push('/explore')}>
                <Text style={styles.startChatButtonText}>Explore Friends</Text>
            </TouchableOpacity>
        )}
      </View>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor }]}>
      {/* Custom Header */}
      <View style={styles.topNav}>
        <View style={styles.leftHeader}>
          <BackButton size={26} color={textColor} style={styles.backButton} />
          <Text style={[styles.headerTitle, { color: textColor }]}>Messages</Text>
        </View>
        <View style={styles.rightIcons}>
          <TouchableOpacity style={styles.navButton}>
            <Add_Icon width={24} height={24} color={textColor} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.navButton}>
            {isDark ? <Menu_Dark width={24} height={24} /> : <Menu_Light width={24} height={24} />}
          </TouchableOpacity>
        </View>
      </View>

      {loading && chats.length === 0 ? (
        <View style={{ paddingHorizontal: 20, paddingTop: 10 }}>
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <MessageSkeleton key={i} isDark={isDark} />
          ))}
        </View>
      ) : (
        <FlatList
          data={filteredChats}
          renderItem={renderChatItem}
          keyExtractor={(item) => item.id}
          ListHeaderComponent={listHeaderComponent}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              colors={[pinkPrimary]}
              tintColor={pinkPrimary}
            />
          }
          ListEmptyComponent={!loading ? <EmptyState /> : null}
          contentContainerStyle={styles.flatListContent}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  topNav: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: Platform.OS === 'ios' ? 60 : 45,
    paddingBottom: 15,
    justifyContent: 'space-between',
  },
  leftHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  backButton: {
    marginRight: 12,
  },
  headerTitle: {
    fontSize: 26,
    fontWeight: '700',
  },
  rightIcons: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  navButton: {
    marginLeft: 22,
  },
  headerContainer: {
    paddingHorizontal: 20,
  },
  searchSection: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    paddingHorizontal: 14,
    marginVertical: 14,
    height: 44,
  },
  searchIconContainer: {
    marginRight: 12,
  },
  searchInput: {
    flex: 1,
    fontSize: 16,
    height: '100%',
    ...Platform.select({
      web: {
        outlineStyle: 'none' as any,
      },
    }),
  },
  sectionHeader: {
    marginTop: 18,
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  recentlyList: {
    paddingBottom: 6,
    paddingRight: 4,
  },
  recentlyItem: {
    alignItems: 'center',
    marginRight: 16,
    width: 72,
  },
  storyRing: {
    width: 68,
    height: 68,
    borderRadius: 34,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  storyInner: {
    width: 62,
    height: 62,
    borderRadius: 31,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recentlyAvatar: {
    width: 62,
    height: 62,
    borderRadius: 31,
    marginBottom: 8,
  },
  onlineIndicator: {
    position: 'absolute',
    bottom: 8,
    right: 4,
    width: 15,
    height: 15,
    borderRadius: 7.5,
    backgroundColor: '#4CAF50',
    borderWidth: 2.5,
  },
  chatOnlineIndicator: {
    bottom: 1,
    right: 1,
    width: 14,
    height: 14,
    borderRadius: 7,
  },
  recentlyName: {
    fontSize: 13,
    textAlign: 'center',
    fontWeight: '600',
  },
  flatListContent: {
    paddingBottom: 30,
  },
  chatItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  chatAvatar: {
    width: 58,
    height: 58,
    borderRadius: 29,
  },
  avatarPlaceholder: {
    backgroundColor: '#f0f0f0',
    justifyContent: 'center',
    alignItems: 'center',
  },
  chatInfo: {
    flex: 1,
    marginLeft: 14,
    justifyContent: 'center',
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 3,
  },
  userName: {
    fontSize: 15,
    fontWeight: '600',
    flexShrink: 1,
  },
  userNameUnread: {
    fontWeight: '700',
  },
  previewRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  lastMessage: {
    fontSize: 14,
    flexShrink: 1,
  },
  lastMessageUnread: {
    fontWeight: '600',
  },
  previewTime: {
    fontSize: 14,
    flexShrink: 0,
  },
  unreadDot: {
    width: 9,
    height: 9,
    borderRadius: 4.5,
    backgroundColor: '#FF4D67',
    marginLeft: 10,
  },
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 40,
    paddingVertical: 60,
  },
  emptyIconCircle: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: 'rgba(255, 77, 103, 0.1)',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 20,
  },
  emptyTitle: {
    fontSize: 22,
    fontWeight: '700',
    marginBottom: 10,
    textAlign: 'center',
  },
  emptySubtitle: {
    fontSize: 16,
    color: '#9E9E9E',
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 30,
  },
  startChatButton: {
    backgroundColor: '#FF4D67',
    paddingHorizontal: 30,
    paddingVertical: 15,
    borderRadius: 30,
    shadowColor: '#FF4D67',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 5,
  },
  startChatButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '700',
  },
  deleteAction: {
    backgroundColor: '#FF4D67',
    justifyContent: 'center',
    alignItems: 'center',
    width: 100,
    height: '100%',
  },
  deleteText: {
    color: 'white',
    fontWeight: '600',
    marginTop: 4,
    fontSize: 12,
  },
});
