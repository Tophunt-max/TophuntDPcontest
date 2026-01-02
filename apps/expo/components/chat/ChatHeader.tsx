
import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Image } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';

interface ChatHeaderProps {
  recipientName: string;
  recipientAvatar: string; // URL or local image source
}

function ChatHeader({ recipientName, recipientAvatar }: ChatHeaderProps) {
  const router = useRouter();

  return (
    <View style={styles.headerContainer}>
      <TouchableOpacity onPress={() => router.back()} style={styles.iconButton}>
        <Ionicons name="arrow-back" size={24} color="black" />
      </TouchableOpacity>
      <Image source={{ uri: recipientAvatar }} style={styles.avatar} />
      <Text style={styles.recipientName}>{recipientName}</Text>
      <View style={styles.rightIcons}>
        <TouchableOpacity style={styles.iconButton}>
          <Ionicons name="call" size={24} color="black" />
        </TouchableOpacity>
        <TouchableOpacity style={styles.iconButton}>
          <Ionicons name="ellipsis-vertical" size={24} color="black" />
        </TouchableOpacity>
      </View>
    </View>
  );
}

ChatHeader.displayName = 'ChatHeader';

export default ChatHeader;

const styles = StyleSheet.create({
  headerContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 10,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
    paddingTop: 40, // Adjust for status bar
  },
  iconButton: {
    padding: 5,
  },
  avatar: {
    width: 35,
    height: 35,
    borderRadius: 17.5,
    marginLeft: 10,
    marginRight: 10,
  },
  recipientName: {
    flex: 1,
    fontSize: 18,
    fontWeight: 'bold',
  },
  rightIcons: {
    flexDirection: 'row',
  },
});
