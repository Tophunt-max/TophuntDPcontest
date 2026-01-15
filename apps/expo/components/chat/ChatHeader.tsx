import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Platform } from 'react-native';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { getOptimizedMediaUrl } from '@/src/utils/media';

// Import Custom SVGs
import { 
  Back_Arrow, 
  Call_Icon, 
  Video_Icon, 
  Menu_Dots, 
  Search_Icon 
} from '@/assets/svgs/message';

interface ChatHeaderProps {
  recipientName: string;
  recipientAvatar: string;
  status?: string;
  onAudioCall?: () => void;
  onVideoCall?: () => void;
  onSearchPress?: () => void;
  onOptionsPress?: () => void;
}

export default function ChatHeader({ 
    recipientName, 
    recipientAvatar, 
    status, 
    onAudioCall, 
    onVideoCall, 
    onSearchPress, 
    onOptionsPress 
}: ChatHeaderProps) {
  const router = useRouter();
  const avatarUri = getOptimizedMediaUrl(recipientAvatar || '');

  return (
    <View style={styles.headerContainer}>
      <TouchableOpacity onPress={() => router.back()} style={styles.iconButton}>
        <Back_Arrow width={24} height={24} color="#000" />
      </TouchableOpacity>
      
      <Image 
        source={{ uri: avatarUri || 'https://via.placeholder.com/150' }} 
        style={styles.avatar} 
        contentFit="cover"
        cachePolicy="memory-disk"
      />
      
      <View style={styles.infoContainer}>
        <Text style={styles.recipientName} numberOfLines={1}>{recipientName}</Text>
        {status && <Text style={[styles.statusText, { color: status === 'online' ? '#4CAF50' : '#9E9E9E' }]}>{status}</Text>}
      </View>

      <View style={styles.rightIcons}>
        <TouchableOpacity onPress={onSearchPress} style={styles.iconButton}>
          <Search_Icon width={24} height={24} color="#000" />
        </TouchableOpacity>
        <TouchableOpacity onPress={onAudioCall} style={styles.iconButton}>
          <Call_Icon width={24} height={24} color="#000" />
        </TouchableOpacity>
        <TouchableOpacity onPress={onVideoCall} style={styles.iconButton}>
          <Video_Icon width={24} height={24} color="#000" />
        </TouchableOpacity>
        <TouchableOpacity onPress={onOptionsPress} style={styles.iconButton}>
          <Menu_Dots width={24} height={24} color="#000" />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  headerContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
    paddingTop: Platform.OS === 'ios' ? 50 : 35,
    paddingBottom: 10,
  },
  iconButton: { padding: 6 },
  avatar: { width: 40, height: 40, borderRadius: 20, marginLeft: 5 },
  infoContainer: { flex: 1, marginLeft: 10, justifyContent: 'center' },
  recipientName: { fontSize: 18, fontWeight: '800', color: '#000', fontFamily: 'Urbanist-Bold' },
  statusText: { fontSize: 12, marginTop: -2, fontFamily: 'Urbanist-Medium' },
  rightIcons: { flexDirection: 'row', alignItems: 'center' },
});
