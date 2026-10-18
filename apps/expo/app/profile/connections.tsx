
import React, { useState, useEffect, useLayoutEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Image,
  TouchableOpacity,
  ActivityIndicator,
  TextInput,
} from 'react-native';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { readApi } from "@/src/services/api";
import { Ionicons } from '@/src/lib/icons';
import { UserListSkeleton } from '@/src/components/skeletons/UserListSkeleton';
import { removeFollowerService, toggleFollowService } from '@/src/services/users';
import { followButtonLabel, followStateFromResult, intentFor, stateInSets, withStateInSets, type FollowState } from '@/src/lib/followState';
import { Alert } from '@/src/lib/appAlert';
import { useAuth } from '@/src/hooks/useAuth';
import { useAuthGate } from '@/src/hooks/useAuthGate';
import { Avatar } from '@/src/components/ui/Avatar';
import { useProfile } from '@/src/hooks/useProfileData';
import { useToast } from '@/src/components/toast/ToastProvider';
import { Colors } from '@/constants/theme';
import { ThemedView } from '@/components/themed-view';
import { CloseIcon } from '@/src/components/ui/CloseIcon';
import { VerifiedBadge } from '@/src/components/ui/VerifiedBadge';

const CARD_MARGIN = 16;

type User = {
    id: string;
    username: string;
    fullName?: string;
    profileImageUrl?: string;
    /** Admin-granted blue check, from users.verified. */
    verified?: boolean;
    profileImageUrlThumb?: string | null;
  };

export default function ConnectionsScreen() {
    const { userId, type } = useLocalSearchParams<{ userId: string; type: 'followers' | 'following' }>();

  const router = useRouter();
  const navigation = useNavigation();
  const { user, loading: authLoading } = useAuth();
  const { data: currentUserProfile } = useProfile(user?.uid || ''); // Fetch current user profile
  const { addToast } = useToast();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';

  // Refined Color Palette
  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;
  const cardBg = isDark ? '#1C1C1E' : '#FFFFFF';
  const textColor = isDark ? '#FFFFFF' : '#121212';
  const subTextColor = isDark ? '#A0A0A5' : '#8A8A8E';
  const primaryColor = '#FF3B30'; // Red/Pink accent
  const inputBg = isDark ? '#262629' : '#F2F2F7';

  const [loading, setLoading] = useState(true);
  const [users, setUsers] = useState<User[]>([]);
  const queryClient = useQueryClient();
  const [followedUsers, setFollowedUsers] = useState<Set<string>>(new Set());
  // Pending requests to PRIVATE accounts — not follows (src/lib/followState.ts).
  const [requestedUsers, setRequestedUsers] = useState<Set<string>>(new Set());

  // State
  const [searchQuery, setSearchQuery] = useState('');
  const themeColors = isDark ? Colors.dark : Colors.light;


  useLayoutEffect(() => {
    navigation.setOptions({
      title: type === 'followers' ? 'Followers' : 'Following',
      headerBackTitleVisible: false,
      headerStyle: { backgroundColor: themeColors.background, shadowOpacity: 0 },
      headerTitleStyle: { color: themeColors.text, fontFamily: 'Urbanist-Bold' },
      headerTintColor: themeColors.text,
    });
  }, [navigation, type, isDark]);

  // Sync followed users from profile
  useEffect(() => {
    if (currentUserProfile && currentUserProfile.following) {
      setFollowedUsers(new Set(currentUserProfile.following));
    }
  }, [currentUserProfile]);

  // Fetch connections immediately — the Worker endpoint uses optionalAuth,
  // so we don't need to wait for Firebase Auth to resolve.
  useEffect(() => {
    fetchConnectionsData();
  }, [userId, type]);

  const fetchConnectionsData = async () => {
    if (!userId || !type) { setLoading(false); return; }
    setLoading(true);
    try {
        // Followers/following now come from the Worker (D1).
        const fetchedUsers = (await readApi(`/read/users/${userId}/${type}`)) as User[];
        setUsers(fetchedUsers || []);
    } catch (error) {
      console.error("Connections error:", error);
      addToast("Failed to load connections", "error");
    } finally {
      setLoading(false);
    }
  };

  const { requireAuth } = useAuthGate();
  const handleAction = (action: () => void) => {
      // The list is public; following prompts sign-in and returns to this list.
      if (requireAuth('follow', { returnTo: `/profile/connections?userId=${encodeURIComponent(userId)}&type=${encodeURIComponent(String(type))}` })) action();
  };

  const handleFollow = async (targetId: string) => {
      handleAction(async () => {
          const before: FollowState = stateInSets(followedUsers, requestedUsers, targetId);
          const apply = (state: FollowState) => {
            setFollowedUsers((f) => withStateInSets(f, requestedUsers, targetId, state).followed);
            setRequestedUsers((r) => withStateInSets(followedUsers, r, targetId, state).requested);
          };
          // Optimistic, then the server's answer: a private account answers
          // `requested`, not `following`.
          apply(before === 'none' ? 'following' : 'none');
          try {
            apply(followStateFromResult(await toggleFollowService(targetId, intentFor(before))));
          } catch (error) {
            apply(before);
            addToast("Failed to update follow status.", "error");
          }
      });
  };

  // Your OWN followers list: "Remove" takes someone out of your followers
  // without blocking them (they are not told). On a private account this is
  // how you take back access.
  const isOwnFollowers = !!user?.uid && user.uid === userId && type === 'followers';
  const handleRemoveFollower = (target: User) => {
    Alert.alert(
      'Remove follower?',
      `TopHunt won't tell @${target.username || 'them'} they were removed from your followers.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            const previous = users;
            setUsers((list) => list.filter((u) => u.id !== target.id));
            try {
              await removeFollowerService(target.id);
              // Your follower count moved.
              void queryClient.invalidateQueries({ queryKey: ['profile', user?.uid] });
            } catch {
              setUsers(previous);
              addToast('Could not remove follower.', 'error');
            }
          },
        },
      ],
    );
  };

  // Filtering
  const filteredUsers = users.filter(u =>
    u.fullName?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    u.username?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // --- RENDER COMPONENTS ---
  const renderHeader = () => (
    <View style={styles.headerContainer}>
      {/* Modern Search Bar */}
      <View style={[styles.searchBox, { backgroundColor: isDark ? '#1C1C1E' : '#FFF', borderColor: isDark ? 'transparent' : '#F0F0F0', borderWidth: 1 }]}>
          <Ionicons name="search" size={20} color={primaryColor} style={{ marginRight: 10 }} />
          <TextInput
              style={[styles.searchInput, { color: textColor }]}
              placeholder={`Search ${type}...`}
              placeholderTextColor={subTextColor}
              value={searchQuery}
              onChangeText={setSearchQuery}
              returnKeyType="search"
          />
          {searchQuery.length > 0 && (
              <TouchableOpacity onPress={() => setSearchQuery('')}>
                  <CloseIcon variant="circle" size={18} color={subTextColor} />
              </TouchableOpacity>
          )}
      </View>
    </View>
  );

  const renderUserCard = ({ item }: { item: any }) => {
      const followState = stateInSets(followedUsers, requestedUsers, item.id);
      const isFollowed = followState !== 'none';
      const isCurrentUser = item.id === user?.uid;
      return (
      <TouchableOpacity
        style={[styles.userCard, { backgroundColor: cardBg }]}
        activeOpacity={0.7}
        onPress={() => handleAction(() => router.push(`/profile?userId=${item.id}`))}
      >
          <Avatar
            uri={(item as any).profileImageUrlThumb || item.profileImageUrl}
            name={item.fullName || item.username}
            size={50}
            style={styles.userAvatar}
          />
          <View style={styles.userDetails}>
              <View style={styles.nameRow}>
                <Text style={[styles.userName, { color: textColor }]} numberOfLines={1}>{item.fullName}</Text>
                <VerifiedBadge verified={(item as any).verified} size={14} />
              </View>
              <Text style={[styles.userHandle, { color: subTextColor }]} numberOfLines={1}>@{item.username}</Text>
          </View>
          {!isCurrentUser && (
            <TouchableOpacity
                style={[
                    styles.followBtn,
                    { backgroundColor: isFollowed ? (isDark ? '#333' : '#EEE') : primaryColor }
                ]}
                onPress={() => handleFollow(item.id)}
            >
                <Text style={[
                    styles.followText,
                    { color: isFollowed ? textColor : '#FFF' }
                ]}>
                    {followButtonLabel(followState)}
                </Text>
            </TouchableOpacity>
          )}
          {isOwnFollowers && !isCurrentUser && (
            <TouchableOpacity
                style={[styles.followBtn, { backgroundColor: isDark ? '#333' : '#EEE', marginLeft: 8 }]}
                onPress={() => handleRemoveFollower(item)}
                accessibilityRole="button"
                accessibilityLabel={`Remove ${item.username || 'follower'}`}
            >
                <Text style={[styles.followText, { color: textColor }]}>Remove</Text>
            </TouchableOpacity>
          )}
      </TouchableOpacity>
  )};

  // Show full-page skeleton while data is loading (no flickering empty list)
  if (loading) {
    return (
      <ThemedView style={[styles.container, { backgroundColor }]}>
        {renderHeader()}
        <UserListSkeleton />
      </ThemedView>
    );
  }

  return (
    <ThemedView style={[styles.container, { backgroundColor }]}>
        <FlatList
            ListHeaderComponent={renderHeader}
            data={filteredUsers}
            renderItem={renderUserCard}
            keyExtractor={(item) => item.id}
            contentContainerStyle={{ paddingBottom: 100 }}
            showsVerticalScrollIndicator={false}
            ListEmptyComponent={() => (
                <View style={{ height: 300, justifyContent: 'center', alignItems:'center' }}>
                    <Text style={{color: subTextColor}}>No users found.</Text>
                </View>
            )}
        />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },

  // Header
  headerContainer: {
      paddingHorizontal: 20,
      paddingTop: 10,
      paddingBottom: 10,
  },

  // Search
  searchBox: {
      flexDirection: 'row',
      alignItems: 'center',
      height: 52,
      borderRadius: 16,
      paddingHorizontal: 16,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.05,
      shadowRadius: 10,
      elevation: 2,
  },
  searchInput: {
      flex: 1,
      fontSize: 16,
      fontFamily: 'Urbanist-Medium',
  },

  // User Cards
  userCard: {
      flexDirection: 'row',
      alignItems: 'center',
      padding: 12,
      borderRadius: 16,
      marginHorizontal: CARD_MARGIN,
      marginBottom: 10,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.05,
      shadowRadius: 4,
      elevation: 2,
  },
  userAvatar: {
      width: 50,
      height: 50,
      borderRadius: 25,
      marginRight: 12,
  },
  userDetails: { flex: 1 },
  userName: { fontSize: 16, fontFamily: 'Urbanist-Bold', flexShrink: 1 },
  nameRow: { flexDirection: 'row', alignItems: 'center' },
  userHandle: { fontSize: 14, fontFamily: 'Urbanist-Medium' },
  followBtn: {
      paddingVertical: 8,
      paddingHorizontal: 16,
      borderRadius: 20,
  },
  followText: {
      fontSize: 12,
      fontFamily: 'Urbanist-Bold',
  },
});
