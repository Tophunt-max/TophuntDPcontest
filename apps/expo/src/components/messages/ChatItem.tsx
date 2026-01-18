import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Image } from 'expo-image';
import { Swipeable } from 'react-native-gesture-handler';
import { Delete_Icon } from '@/assets/svgs';
import { getOptimizedMediaUrl } from '@/src/utils/media';

interface ChatItemProps {
  item: any;
  currentUserId: string;
  onPress: (chatId: string) => void;
  onDelete: (chatId: string) => void;
  textColor: string;
  backgroundColor: string;
}

export const ChatItem: React.FC<ChatItemProps> = ({ 
  item, 
  currentUserId, 
  onPress, 
  onDelete, 
  textColor, 
  backgroundColor 
}) => {
  const otherUserId = item.participants?.find((uid: string) => uid !== currentUserId);
  const otherUser = item.participantsData?.[otherUserId] || {};
  
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

  const time = formatTime(item.lastMessage?.createdAt);
  const unreadCount = item.unreadCount?.[currentUserId || ''] || 0; 
  const avatarUrl = getOptimizedMediaUrl(otherUser.photoURL || '');

  return (
    <Swipeable renderRightActions={() => (
      <TouchableOpacity onPress={() => onDelete(item.id)} style={styles.deleteAction}>
        <Delete_Icon width={24} height={24} />
        <Text style={styles.deleteText}>Delete</Text>
      </TouchableOpacity>
    )}>
      <TouchableOpacity
        style={[styles.chatItem, { backgroundColor: backgroundColor }]}
        onPress={() => onPress(item.id)}
      >
        <Image 
          source={{ uri: avatarUrl || 'https://via.placeholder.com/150' }} 
          style={styles.chatAvatar} 
          contentFit="cover" 
        />
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
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{unreadCount}</Text>
              </View>
            )}
          </View>
        </View>
      </TouchableOpacity>
    </Swipeable>
  );
};

const styles = StyleSheet.create({
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
});
