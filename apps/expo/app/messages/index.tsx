import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  TextInput,
  ScrollView,
  Image,
  Platform,
  Keyboard,
  Animated,
  Alert,
  RefreshControl,
  useColorScheme
} from 'react-native';
import { auth } from '@/src/services/firebase/initFirebase';
import { readApi, poll, callApi } from '@/src/services/api';
import { useRouter } from 'expo-router';
import { useThemeColor } from '@/hooks/use-theme-color';
import { ThemedView } from '@/components/themed-view';
import { MessageSkeleton } from '@/src/components/messages/MessageSkeleton';
import { Swipeable } from 'react-native-gesture-handler';
import { Colors } from '@/constants/theme';

// Import Icons from assets
import { 
  Left_Arrow, 
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

// --- TYPES ---
interface UserData {
  uid: string;
  displayName: string;
  photoURL: string;
  isOnline?: boolean;
}

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

export default function MessagesScreen() {
  const [chats, setChats] = useState<ChatItemType[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  
  const currentUser = auth.currentUser;
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

  const interpolatedBackgroundColor = focusAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [isDark ? '#1F222A' : '#F5F5F5', isDark ? '#2D1F22' : '#FFEBEE'],
  });

  const interpolatedBorderColor = focusAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [isDark ? '#35383F' : '#eee', '#FF4D67'],
  });

  const fetchChats = useCallback(() => {
    if (!currentUser) {
      setLoading(false);
      setRefreshing(false);
      return;
    }

    // Polling replaces the Firestore onSnapshot listener.
    const unsubscribe = poll<ChatItemType[]>(
      () => readApi('/read/chats'),
      (chatsData) => {
        setChats(chatsData || []);
        setLoading(false);
        setRefreshing(false);
      },
      8000,
    );

    return unsubscribe;
  }, [currentUser]);

  useEffect(() => {
    const unsubscribe = fetchChats();
    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [fetchChats]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setTimeout(() => {
      setRefreshing(false);
    }, 1500);
  }, []);

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
    return chats.filter(chat => {
      const otherUser = chat.usersData?.find(u => u.uid !== currentUser?.uid);
      return otherUser?.displayName?.toLowerCase().includes(searchText.toLowerCase());
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
    const isOnline = otherUser?.isOnline ?? false;

    return (
      <View key={id} style={styles.recentlyItem}>
        <TouchableOpacity onPress={() => router.push(`/messages/chat/${id}`)}>
          <View>
            {avatar ? (
              <Image source={{ uri: avatar }} style={styles.recentlyAvatar} />
            ) : (
              <View style={[styles.recentlyAvatar, styles.avatarPlaceholder]}>
                <Text style={{ color: '#ccc', fontSize: 10 }}>User</Text>
              </View>
            )}
            {isOnline && <View style={[styles.onlineIndicator, { borderColor: backgroundColor }]} />}
          </View>
        </TouchableOpacity>
        <Text style={[styles.recentlyName, { color: textColor }]} numberOfLines={1}>
          {name.split(' ')[0]}
        </Text>
      </View>
    );
  }, [currentUser, router, textColor, backgroundColor]);

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
    const isOnline = otherUser?.isOnline ?? false;

    return (
      <Swipeable
        renderRightActions={() => renderRightActions(item.id)}
        friction={2}
        rightThreshold={40}
      >
        <TouchableOpacity
          style={[styles.chatItem, { backgroundColor: backgroundColor }]}
          onPress={() => router.push(`/messages/chat/${item.id}`)}
        >
          <View>
            {otherUser?.photoURL ? (
              <Image source={{ uri: otherUser.photoURL }} style={styles.chatAvatar} />
            ) : (
              <View style={[styles.chatAvatar, styles.avatarPlaceholder]}>
                 <Text style={{ color: '#ccc', fontSize: 12 }}>User</Text>
              </View>
            )}
            {isOnline && <View style={[styles.onlineIndicator, styles.chatOnlineIndicator, { borderColor: backgroundColor }]} />}
          </View>
          
          <View style={styles.chatInfo}>
            <View style={styles.chatHeaderRow}>
              <Text style={[styles.userName, { color: textColor }]}>{otherUser?.displayName || 'User'}</Text>
              {unreadCount > 0 && (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{unreadCount}</Text>
                </View>
              )}
            </View>
            
            <View style={styles.chatFooterRow}>
              <Text style={[styles.lastMessage, { color: 'gray' }]} numberOfLines={1}>
                {item.lastMessage?.text || 'No messages yet'}
              </Text>
              <Text style={[styles.timeText, { color: 'gray' }]}>{time}</Text>
            </View>
          </View>
        </TouchableOpacity>
      </Swipeable>
    );
  }, [currentUser, router, textColor, backgroundColor]);

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
            borderWidth: 1 
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
          <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
            <Left_Arrow width={28} height={28} color={textColor} />
          </TouchableOpacity>
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
          ListEmptyComponent={!loading && <EmptyState />}
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
    paddingHorizontal: 16,
    marginVertical: 15,
    height: 56,
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
        outlineStyle: 'none',
      },
    }),
  },
  sectionHeader: {
    marginVertical: 15,
  },
  sectionTitle: {
    fontSize: 22,
    fontWeight: '700',
  },
  recentlyList: {
    paddingBottom: 10,
  },
  recentlyItem: {
    alignItems: 'center',
    marginRight: 20,
    width: 75,
  },
  recentlyAvatar: {
    width: 72,
    height: 72,
    borderRadius: 36,
    marginBottom: 8,
    borderWidth: 1.5,
    borderColor: '#eee',
  },
  onlineIndicator: {
    position: 'absolute',
    bottom: 10,
    right: 2,
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#4CAF50',
    borderWidth: 2,
  },
  chatOnlineIndicator: {
    bottom: 2,
    right: 2,
    width: 12,
    height: 12,
  },
  recentlyName: {
    fontSize: 14,
    textAlign: 'center',
    fontWeight: '600',
  },
  flatListContent: {
    paddingBottom: 30,
  },
  chatItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 15,
  },
  chatAvatar: {
    width: 68,
    height: 68,
    borderRadius: 34,
  },
  avatarPlaceholder: {
    backgroundColor: '#f0f0f0',
    justifyContent: 'center',
    alignItems: 'center',
  },
  chatInfo: {
    flex: 1,
    marginLeft: 15,
    justifyContent: 'center',
  },
  chatHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  userName: {
    fontSize: 18,
    fontWeight: '600',
  },
  chatFooterRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  lastMessage: {
    fontSize: 15,
    flex: 1,
    marginRight: 10,
  },
  timeText: {
    fontSize: 13,
  },
  badge: {
    backgroundColor: '#FF4D67',
    borderRadius: 12,
    minWidth: 22,
    height: 22,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 6,
  },
  badgeText: {
    color: 'white',
    fontSize: 12,
    fontWeight: 'bold',
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
