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
  Alert,
  RefreshControl,
  useColorScheme
} from 'react-native';
import { Image } from 'expo-image';
import { collection, query, where, onSnapshot, orderBy, doc, deleteDoc } from 'firebase/firestore';
import { firestore, auth } from '@/src/services/firebase/initFirebase';
import { useRouter } from 'expo-router';
import { Colors } from '@/constants/theme';
import { getOptimizedMediaUrl } from '@/src/utils/media';
import { MessageSkeleton } from '@/src/components/messages/MessageSkeleton';
import { Swipeable } from 'react-native-gesture-handler';

// Import Icons from assets (Preserving your original icons)
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

export default function MessagesScreen() {
  const [chats, setChats] = useState<any[]>([]);
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
      return;
    }

    const chatsRef = collection(firestore, 'chats');
    // Using new schema field 'participants'
    const q = query(
      chatsRef,
      where('participants', 'array-contains', currentUser.uid),
      orderBy('updatedAt', 'desc')
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const chatsData = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data(),
      }));
      setChats(chatsData);
      setLoading(false);
      setRefreshing(false);
    }, (err) => {
      console.error("Firestore Messages Error:", err);
      setLoading(false);
      setRefreshing(false);
    });

    return unsubscribe;
  }, [currentUser]);

  useEffect(() => {
    const unsubscribe = fetchChats();
    return () => { if (unsubscribe) unsubscribe(); };
  }, [fetchChats]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchChats();
  }, [fetchChats]);

  const handleDeleteChat = (chatId: string) => {
    Alert.alert("Delete Chat", "Are you sure you want to delete this chat?", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: async () => {
          try { await deleteDoc(doc(firestore, "chats", chatId)); } catch (e) { console.error(e); }
      }}
    ]);
  };

  const filteredChats = useMemo(() => {
    if (!searchText) return chats;
    return chats.filter(chat => {
      const otherUserId = chat.participants?.find((uid: string) => uid !== currentUser?.uid);
      const otherUser = chat.participantsData?.[otherUserId] || {};
      return otherUser.displayName?.toLowerCase().includes(searchText.toLowerCase());
    });
  }, [chats, searchText, currentUser]);

  const formatTime = (timestamp: any) => {
    if (!timestamp) return '';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    if (diff < 86400000 && now.getDate() === date.getDate()) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    }
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };

  const renderRecentlyItem = (item: any) => {
    const otherUserId = item.participants?.find((uid: string) => uid !== currentUser?.uid);
    const otherUser = item.participantsData?.[otherUserId] || {};
    const avatar = getOptimizedMediaUrl(otherUser.photoURL || '');

    return (
      <View key={item.id} style={styles.recentlyItem}>
        <TouchableOpacity onPress={() => router.push(`/messages/chat/${item.id}`)}>
          <Image source={{ uri: avatar || 'https://via.placeholder.com/150' }} style={styles.recentlyAvatar} contentFit="cover" />
        </TouchableOpacity>
        <Text style={[styles.recentlyName, { color: textColor }]} numberOfLines={1}>
          {otherUser.displayName?.split(' ')[0] || 'User'}
        </Text>
      </View>
    );
  };

  const renderChatItem = useCallback(({ item }: { item: any }) => {
    const otherUserId = item.participants?.find((uid: string) => uid !== currentUser?.uid);
    const otherUser = item.participantsData?.[otherUserId] || {};
    const time = formatTime(item.lastMessage?.createdAt);
    const unreadCount = item.unreadCount?.[currentUser?.uid || ''] || 0; 
    const avatarUrl = getOptimizedMediaUrl(otherUser.photoURL || '');

    return (
      <Swipeable renderRightActions={() => (
        <TouchableOpacity onPress={() => handleDeleteChat(item.id)} style={styles.deleteAction}>
          <Delete_Icon width={24} height={24} />
          <Text style={styles.deleteText}>Delete</Text>
        </TouchableOpacity>
      )}>
        <TouchableOpacity
          style={[styles.chatItem, { backgroundColor: backgroundColor }]}
          onPress={() => router.push(`/messages/chat/${item.id}`)}
        >
          <Image source={{ uri: avatarUrl || 'https://via.placeholder.com/150' }} style={styles.chatAvatar} contentFit="cover" />
          <View style={styles.chatInfo}>
            <View style={styles.chatHeaderRow}>
              <Text style={[styles.userName, { color: textColor }]}>{otherUser.displayName || 'User'}</Text>
              <Text style={[styles.timeText, { color: 'gray' }]}>{time}</Text>
            </View>
            <View style={styles.chatFooterRow}>
              <Text style={[styles.lastMessage, { color: 'gray' }]} numberOfLines={1}>
                {item.lastMessage?.text || 'No messages yet'}
              </Text>
              {unreadCount > 0 && (
                <View style={styles.badge}><Text style={styles.badgeText}>{unreadCount}</Text></View>
              )}
            </View>
          </View>
        </TouchableOpacity>
      </Swipeable>
    );
  }, [currentUser, router, textColor, backgroundColor]);

  return (
    <View style={[styles.container, { backgroundColor }]}>
      <View style={styles.topNav}>
        <View style={styles.leftHeader}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
            <Left_Arrow width={28} height={28} color={textColor} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: textColor }]}>Messages</Text>
        </View>
        <View style={styles.rightIcons}>
          <TouchableOpacity style={styles.navButton}><Add_Icon width={24} height={24} color={textColor} /></TouchableOpacity>
          <TouchableOpacity style={styles.navButton}>{isDark ? <Menu_Dark width={24} height={24} /> : <Menu_Light width={24} height={24} />}</TouchableOpacity>
        </View>
      </View>

      <FlatList
        data={filteredChats}
        renderItem={renderChatItem}
        keyExtractor={(item) => item.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[pinkPrimary]} />}
        ListHeaderComponent={() => (
          <View style={styles.headerContainer}>
            <Animated.View style={[styles.searchSection, { backgroundColor: interpolatedBackgroundColor, borderColor: interpolatedBorderColor, borderWidth: 1 }]}>
               <View style={{ marginRight: 12 }}>{isDark ? <Search_Dark width={20} height={20} /> : <Search_Light width={20} height={20} />}</View>
               <TextInput style={[styles.searchInput, { color: textColor }]} placeholder="Search" value={searchText} onChangeText={setSearchText} onFocus={() => setIsFocused(true)} onBlur={() => setIsFocused(false)} />
               <Control width={20} height={20} fill={pinkPrimary} />
            </Animated.View>
            {chats.length > 0 && !searchText && (
              <>
                <Text style={[styles.sectionTitle, { color: textColor }]}>Recently</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.recentlyList}>
                  {chats.slice(0, 8).map(renderRecentlyItem)}
                </ScrollView>
                <Text style={[styles.sectionTitle, { color: textColor, marginTop: 15 }]}>Message</Text>
              </>
            )}
          </View>
        )}
        ListEmptyComponent={() => !loading && (
          <View style={styles.emptyContainer}>
            <View style={styles.emptyIconCircle}>
               {isDark ? <Inbox_Dark width={60} height={60} /> : <Inbox_Light width={60} height={60} />}
            </View>
            <Text style={[styles.emptyTitle, { color: textColor }]}>No messages yet</Text>
            <TouchableOpacity style={styles.startChatButton} onPress={() => router.push('/explore')}>
                <Text style={styles.startChatButtonText}>Explore Friends</Text>
            </TouchableOpacity>
          </View>
        )}
        contentContainerStyle={{ paddingBottom: 30 }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  topNav: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: Platform.OS === 'ios' ? 60 : 45, paddingBottom: 15, justifyContent: 'space-between' },
  leftHeader: { flexDirection: 'row', alignItems: 'center' },
  backButton: { marginRight: 12 },
  headerTitle: { fontSize: 26, fontWeight: '700' },
  rightIcons: { flexDirection: 'row', alignItems: 'center' },
  navButton: { marginLeft: 22 },
  headerContainer: { paddingHorizontal: 20 },
  searchSection: { flexDirection: 'row', alignItems: 'center', borderRadius: 12, paddingHorizontal: 16, marginVertical: 15, height: 56 },
  searchInput: { flex: 1, fontSize: 16, height: '100%' },
  sectionTitle: { fontSize: 22, fontWeight: '700', marginBottom: 15 },
  recentlyList: { paddingBottom: 10 },
  recentlyItem: { alignItems: 'center', marginRight: 20, width: 75 },
  recentlyAvatar: { width: 72, height: 72, borderRadius: 36, marginBottom: 8, borderWidth: 1.5, borderColor: '#eee' },
  recentlyName: { fontSize: 14, textAlign: 'center', fontWeight: '600' },
  chatItem: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 15 },
  chatAvatar: { width: 68, height: 68, borderRadius: 34 },
  chatInfo: { flex: 1, marginLeft: 15, justifyContent: 'center' },
  chatHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  userName: { fontSize: 18, fontWeight: '600' },
  chatFooterRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  lastMessage: { fontSize: 15, flex: 1, marginRight: 10 },
  timeText: { fontSize: 13 },
  badge: { backgroundColor: '#FF4D67', borderRadius: 12, minWidth: 22, height: 22, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 6 },
  badgeText: { color: 'white', fontSize: 12, fontWeight: 'bold' },
  deleteAction: { backgroundColor: '#FF4D67', justifyContent: 'center', alignItems: 'center', width: 100, height: '100%' },
  deleteText: { color: 'white', fontWeight: '600', marginTop: 4, fontSize: 12 },
  emptyContainer: { alignItems: 'center', justifyContent: 'center', paddingVertical: 60 },
  emptyIconCircle: { width: 120, height: 120, borderRadius: 60, backgroundColor: 'rgba(255, 77, 103, 0.1)', justifyContent: 'center', alignItems: 'center', marginBottom: 20 },
  emptyTitle: { fontSize: 22, fontWeight: '700', marginBottom: 20 },
  startChatButton: { backgroundColor: '#FF4D67', paddingHorizontal: 30, paddingVertical: 15, borderRadius: 30 },
  startChatButtonText: { color: 'white', fontSize: 16, fontWeight: '700' },
});
