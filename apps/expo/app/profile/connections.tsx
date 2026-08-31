
import React, { useState, useEffect, useLayoutEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Image,
  TouchableOpacity,
  ActivityIndicator,
  Dimensions,
  TextInput,
} from 'react-native';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { readApi } from "@/src/services/api";
import { Ionicons } from '@/src/lib/icons';
import { UserListSkeleton } from '@/src/components/skeletons/UserListSkeleton';
import { toggleFollowService } from '@/src/services/users';
import { useAuth } from '@/src/hooks/useAuth';
import { Avatar } from '@/src/components/ui/Avatar';
import { useProfile } from '@/src/hooks/useProfileData';
import { useToast } from '@/src/components/toast/ToastProvider';
import { Colors } from '@/constants/theme';
import { ThemedView } from '@/components/themed-view';
import { CloseIcon } from '@/src/components/ui/CloseIcon';
import { VerifiedBadge } from '@/src/components/ui/VerifiedBadge';

const { width } = Dimensions.get('window');
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
  const [followedUsers, setFollowedUsers] = useState<Set<string>>(new Set());

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

  const handleAction = (action: () => void) => {
      if (!user) {
          const redirect = encodeURIComponent(`/profile/connections?userId=${userId}&type=${type}`);
          router.push(`/auth/login?redirect=${redirect}`);
      } else {
          action();
      }
  };

  const handleFollow = async (targetId: string) => {
      handleAction(async () => {
          // Optimistic Update
          const isFollowing = followedUsers.has(targetId);
          setFollowedUsers(prev => {
              const newSet = new Set(prev);
              if (isFollowing) newSet.delete(targetId);
              else newSet.add(targetId);
              return newSet;
          });

          try {
            await toggleFollowService(targetId);
            // addToast(isFollowing ? "Unfollowed" : "Followed successfully!", "success");
          } catch (error) {
            // Revert on failure
            setFollowedUsers(prev => {
                const newSet = new Set(prev);
                if (isFollowing) newSet.add(targetId);
                else newSet.delete(targetId);
                return newSet;
            });
            addToast("Failed to update follow status.", "error");
          }
      });
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
      const isFollowed = followedUsers.has(item.id);
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
                    {isFollowed ? 'Following' : 'Follow'}
                </Text>
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
