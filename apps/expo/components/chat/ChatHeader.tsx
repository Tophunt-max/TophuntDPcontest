
import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { LinearGradient } from 'expo-linear-gradient';
import { Avatar } from '@/src/components/ui/Avatar';
import { BackButton } from '@/src/components/ui/BackButton';

const ONLINE_GREEN = '#B9F6CA';
// Matches the Messages inbox hero gradient so the whole feature feels cohesive.
const HERO_GRADIENT = ['#FF4D67', '#FF5E8E', '#8A5CF6'] as const;

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
    <LinearGradient
      colors={HERO_GRADIENT}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={styles.headerContainer}
    >
      <BackButton size={22} color="#FFFFFF" style={styles.iconButton} />
      <View style={styles.avatarWrap}>
        <Avatar uri={recipientAvatar} name={recipientName} size={38} style={styles.avatar} />
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
            <Ionicons name="search" size={22} color="#FFFFFF" />
          </TouchableOpacity>
        )}
        <TouchableOpacity style={styles.iconButton}>
          <Ionicons name="ellipsis-vertical" size={23} color="#FFFFFF" />
        </TouchableOpacity>
      </View>
    </LinearGradient>
  );
}

ChatHeader.displayName = 'ChatHeader';

export default ChatHeader;

const styles = StyleSheet.create({
  headerContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingBottom: 14,
    paddingTop: 44, // Adjust for status bar
    borderBottomLeftRadius: 24,
    borderBottomRightRadius: 24,
    shadowColor: '#8A5CF6',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.25,
    shadowRadius: 12,
    elevation: 8,
  },
  iconButton: {
    padding: 5,
  },
  avatarWrap: {
    marginLeft: 6,
    marginRight: 12,
  },
  avatar: {
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.7)',
  },
  onlineDot: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#39D98A',
    borderWidth: 2,
    borderColor: '#FFFFFF',
  },
  titleBlock: {
    flex: 1,
    justifyContent: 'center',
  },
  recipientName: {
    fontSize: 18,
    fontWeight: '800',
    color: '#FFFFFF',
  },
  subtitle: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.85)',
    marginTop: 1,
  },
  subtitleOnline: {
    color: ONLINE_GREEN,
    fontWeight: '700',
  },
  rightIcons: {
    flexDirection: 'row',
    alignItems: 'center',
  },
});
