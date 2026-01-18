import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  ScrollView,
  Animated,
  Alert,
  RefreshControl,
  useColorScheme
} from 'react-native';
import { collection, query, where, onSnapshot, orderBy, doc, deleteDoc } from 'firebase/firestore';
import { firestore, auth } from '@/src/services/firebase/initFirebase';
import { useRouter } from 'expo-router';
import { Colors } from '@/constants/theme';
import { MessagesHeader } from '@/src/components/messages/MessagesHeader';
import { SearchBar } from '@/src/components/messages/SearchBar';
import { RecentlyItem } from '@/src/components/messages/RecentlyItem';
import { ChatItem } from '@/src/components/messages/ChatItem';
import { EmptyMessages } from '@/src/components/messages/EmptyMessages';

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

  const renderChatItem = useCallback(({ item }: { item: any }) => (
    <ChatItem 
      item={item} 
      currentUserId={currentUser?.uid || ''} 
      onPress={(id) => router.push(`/messages/chat/${id}`)}
      onDelete={handleDeleteChat}
      textColor={textColor}
      backgroundColor={backgroundColor}
    />
  ), [currentUser, router, textColor, backgroundColor]);

  return (
    <View style={[styles.container, { backgroundColor }]}>
      <MessagesHeader 
        title="Messages" 
        onAddPress={() => {}} 
        onMenuPress={() => {}} 
      />

      <FlatList
        data={filteredChats}
        renderItem={renderChatItem}
        keyExtractor={(item) => item.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[pinkPrimary]} />}
        ListHeaderComponent={() => (
          <View style={styles.headerContainer}>
            <SearchBar 
              value={searchText}
              onChangeText={setSearchText}
              onFocus={() => setIsFocused(true)}
              onBlur={() => setIsFocused(false)}
              interpolatedBackgroundColor={interpolatedBackgroundColor}
              interpolatedBorderColor={interpolatedBorderColor}
            />
            {chats.length > 0 && !searchText && (
              <>
                <Text style={[styles.sectionTitle, { color: textColor }]}>Recently</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.recentlyList}>
                  {chats.slice(0, 8).map(item => (
                    <RecentlyItem 
                      key={item.id} 
                      item={item} 
                      currentUserId={currentUser?.uid || ''} 
                      onPress={(id) => router.push(`/messages/chat/${id}`)}
                      textColor={textColor}
                    />
                  ))}
                </ScrollView>
                <Text style={[styles.sectionTitle, { color: textColor, marginTop: 15 }]}>Message</Text>
              </>
            )}
          </View>
        )}
        ListEmptyComponent={() => !loading && <EmptyMessages />}
        contentContainerStyle={{ paddingBottom: 30 }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  headerContainer: { paddingHorizontal: 20 },
  sectionTitle: { fontSize: 22, fontWeight: '700', marginBottom: 15 },
  recentlyList: { paddingBottom: 10 },
});
