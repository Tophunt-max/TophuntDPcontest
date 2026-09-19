
import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Avatar } from '@/src/components/ui/Avatar';
import { BackButton } from '@/src/components/ui/BackButton';

const ONLINE_GREEN = '#4CAF50';

interface ChatHeaderProps {
  recipientName: string;
  /** Remote avatar URL, or null/undefined to render local initials. */
  recipientAvatar?: string | null;
  /** Live presence: the other member currently has an open realtime socket. */
  online?: boolean;
  /** Epoch ms of the other member's last connect/disconnect; null if unknown. */
  lastSeen?: number | null;
  /** Toggle the in-conversation message search bar. */
  onSearchPress?: () => void;
}

/** "last seen just now / 5m / 3h / 2d ago", or an absolute date past a week. */
function formatLastSeen(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 0) return 'just now';
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'last seen just now';
  if (min < 60) return `last seen ${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `last seen ${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 7) return `last seen ${days}d ago`;
  return `last seen ${new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
}

function ChatHeader({ recipientName, recipientAvatar, online, lastSeen, onSearchPress }: ChatHeaderProps) {
  const subtitle = online ? 'Online' : lastSeen ? formatLastSeen(lastSeen) : null;

  return (
    <View style={styles.headerContainer}>
      <BackButton size={22} color="black" style={styles.iconButton} />
      <View>
        <Avatar uri={recipientAvatar} name={recipientName} size={35} style={styles.avatar} />
        {online && <View style={styles.onlineDot} />}
      </View>
      <View style={styles.titleBlock}>
        <Text style={styles.recipientName} numberOfLines={1}>
          {recipientName}
        </Text>
        {subtitle && (
          <Text style={[styles.subtitle, online && styles.subtitleOnline]} numberOfLines={1}>
            {subtitle}
          </Text>
        )}
      </View>
      <View style={styles.rightIcons}>
        {onSearchPress && (
          <TouchableOpacity style={styles.iconButton} onPress={onSearchPress} accessibilityLabel="Search messages">
            <Ionicons name="search" size={23} color="black" />
          </TouchableOpacity>
        )}
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
  onlineDot: {
    position: 'absolute',
    bottom: 0,
    right: 8,
    width: 11,
    height: 11,
    borderRadius: 6,
    backgroundColor: ONLINE_GREEN,
    borderWidth: 2,
    borderColor: '#fff',
  },
  titleBlock: {
    flex: 1,
    justifyContent: 'center',
  },
  recipientName: {
    fontSize: 18,
    fontWeight: 'bold',
  },
  subtitle: {
    fontSize: 12,
    color: '#9AA0A6',
    marginTop: 1,
  },
  subtitleOnline: {
    color: ONLINE_GREEN,
    fontWeight: '600',
  },
  rightIcons: {
    flexDirection: 'row',
    alignItems: 'center',
  },
});
