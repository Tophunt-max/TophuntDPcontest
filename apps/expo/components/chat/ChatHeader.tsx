
import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Avatar } from '@/src/components/ui/Avatar';
import { BackButton } from '@/src/components/ui/BackButton';

interface ChatHeaderProps {
  recipientName: string;
  /** Remote avatar URL, or null/undefined to render local initials. */
  recipientAvatar?: string | null;
}

function ChatHeader({ recipientName, recipientAvatar }: ChatHeaderProps) {
  return (
    <View style={styles.headerContainer}>
      <BackButton size={22} color="black" style={styles.iconButton} />
      <Avatar uri={recipientAvatar} name={recipientName} size={35} style={styles.avatar} />
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
