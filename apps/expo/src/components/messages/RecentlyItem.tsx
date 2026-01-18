import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Image } from 'expo-image';
import { getOptimizedMediaUrl } from '@/src/utils/media';

interface RecentlyItemProps {
  item: any;
  currentUserId: string;
  onPress: (chatId: string) => void;
  textColor: string;
}

export const RecentlyItem: React.FC<RecentlyItemProps> = ({ item, currentUserId, onPress, textColor }) => {
  const otherUserId = item.participants?.find((uid: string) => uid !== currentUserId);
  const otherUser = item.participantsData?.[otherUserId] || {};
  const avatar = getOptimizedMediaUrl(otherUser.photoURL || '');

  return (
    <View style={styles.recentlyItem}>
      <TouchableOpacity onPress={() => onPress(item.id)}>
        <Image 
          source={{ uri: avatar || 'https://via.placeholder.com/150' }} 
          style={styles.recentlyAvatar} 
          contentFit="cover" 
        />
      </TouchableOpacity>
      <Text style={[styles.recentlyName, { color: textColor }]} numberOfLines={1}>
        {otherUser.displayName?.split(' ')[0] || 'User'}
      </Text>
    </View>
  );
};

const styles = StyleSheet.create({
  recentlyItem: { alignItems: 'center', marginRight: 20, width: 75 },
  recentlyAvatar: { width: 72, height: 72, borderRadius: 36, marginBottom: 8, borderWidth: 1.5, borderColor: '#eee' },
  recentlyName: { fontSize: 14, textAlign: 'center', fontWeight: '600' },
});
