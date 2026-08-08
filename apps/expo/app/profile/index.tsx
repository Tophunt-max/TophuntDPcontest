import React, { useState, useEffect, useMemo } from 'react';
import { View, StyleSheet, SafeAreaView, Text, Button, ActivityIndicator, ScrollView, useColorScheme } from 'react-native';
import { useRouter, useLocalSearchParams, usePathname } from 'expo-router';
import { useAuth } from '@/src/services/auth';
import { useProfile, useUserPosts, useToggleFollow, useUserBookmarks } from '@/src/hooks/useProfileData';
import ProfileHeader from '@/src/components/profile/ProfileHeader';
import Highlights from '@/src/components/profile/Highlights';
import ProfileTabs from '@/src/components/profile/ProfileTabs';
import PostGrid from '@/src/components/profile/PostGrid';
import { ProfileHeaderSkeleton, PostGridSkeleton } from '@/src/components/profile/ProfileSkeleton';
import { WalletCard } from '@/src/components/profile/WalletCard';
import { BottomNav } from '@/src/components/home/BottomNav';
import { notificationService } from '@/src/services/notifications/notificationService';
import { Colors } from '@/constants/theme';
import { PostCard } from '@/src/components/home/PostCard';

const ProfilePage = () => {
  const router = useRouter();
  const { user: currentUser, loading: authLoading } = useAuth();
  const params = useLocalSearchParams();
  const userIdParam = params.userId as string | undefined;
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;
  
  const [targetId, setTargetId] = useState<string | null>(null);
  const [isRedirecting, setIsRedirecting] = useState(false);

  useEffect(() => {
    if (!authLoading) {
        if (!currentUser) {
            setIsRedirecting(true);
            const redirectPath = userIdParam ? `/profile?userId=${userIdParam}` : '/profile';
            const encodedRedirect = encodeURIComponent(redirectPath);
            router.replace(`/auth/login?redirect=${encodedRedirect}`);
            return;
        }

        const id = userIdParam || currentUser?.uid;
        if (id) {
            setTargetId(id);
            if (id !== currentUser?.uid) {
                notificationService.notifyProfileVisit(id);
            }
        }
    }
  }, [authLoading, userIdParam, currentUser, router]);

  if (authLoading || isRedirecting || (!targetId && !authLoading)) {
    return (
        <SafeAreaView style={[styles.container, { backgroundColor }]}>
            <ScrollView showsVerticalScrollIndicator={false}>
                <ProfileHeaderSkeleton />
                <PostGridSkeleton />
            </ScrollView>
            <BottomNav backgroundColor={backgroundColor} isDark={isDark} />
        </SafeAreaView>
    );
  }

  if (!targetId) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor }]}>
        <View style={styles.center}>
          <Text style={[styles.errorText, { color: isDark ? '#fff' : '#000' }]}>User not found.</Text>
          <Button title="Go Home" onPress={() => router.replace('/home')} />
        </View>
      </SafeAreaView>
    );
  }

  return <ProfileContent targetUserId={targetId} />;
};

const ProfileContent = ({ targetUserId }: { targetUserId: string }) => {
  const router = useRouter();
  const { user: currentUser } = useAuth();
  const isOwnProfile = currentUser?.uid === targetUserId;
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const backgroundColor = isDark ? Colors.dark.text : Colors.light.background; // Fixed text color variable used for background issue

  const { 
    data: profile, 
    isLoading: profileLoading, 
    refetch: refetchProfile 
  } = useProfile(targetUserId);

  const { data: myProfile } = useProfile(currentUser?.uid || '');

  const isFollowing = useMemo(() => {
    return myProfile?.following?.includes(targetUserId) || false;
  }, [myProfile, targetUserId]);

  const { 
    data: postsData, 
    isLoading: postsLoading, 
    fetchNextPage, 
    hasNextPage, 
    refetch: refetchPosts, 
    isRefetching 
  } = useUserPosts(targetUserId);

  const { data: bookmarks, isLoading: bookmarksLoading, refetch: refetchBookmarks } = useUserBookmarks(targetUserId);
  
  const { mutate: toggleFollow } = useToggleFollow();
  const [activeTab, setActiveTab] = useState<'posts' | 'reels' | 'tags'>('posts');

  const handleToggleFollow = () => {
    if (!isOwnProfile) toggleFollow(targetUserId);
  };

  const handleRefresh = async () => {
    await Promise.all([refetchProfile(), refetchPosts(), refetchBookmarks()]);
  };

  if (profileLoading && !profile) {
    return (
        <SafeAreaView style={[styles.container, { backgroundColor: isDark ? Colors.dark.background : Colors.light.background }]}>
            <ScrollView showsVerticalScrollIndicator={false}>
                <ProfileHeaderSkeleton />
                <PostGridSkeleton />
            </ScrollView>
            <BottomNav backgroundColor={isDark ? Colors.dark.background : Colors.light.background} isDark={isDark} />
        </SafeAreaView>
    );
  }

  const posts = postsData?.pages.flatMap(page => page.posts) || [];

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: isDark ? Colors.dark.background : Colors.light.background }]}>
      <PostGrid
        posts={activeTab === 'posts' ? posts : []}
        onLoadMore={() => hasNextPage && fetchNextPage()}
        isLoading={postsLoading || (activeTab === 'tags' && bookmarksLoading)}
        refreshing={isRefetching}
        onRefresh={handleRefresh}
        ListHeaderComponent={
          <>
            <ProfileHeader 
              user={profile!} 
              isOwnProfile={isOwnProfile}
              onToggleFollow={handleToggleFollow}
              isFollowing={isFollowing}
            />
            {isOwnProfile && (
              <WalletCard 
                Dpcoin={profile?.Dpcoin || 0} 
                stats={profile?.stats || { contestsJoined: 0, wins: 0, totalVotesReceived: 0 }} 
                onPress={() => router.push('/wallet')}
              />
            )}
            <Highlights userId={targetUserId} />
            <ProfileTabs 
              activeTab={activeTab} 
              onChangeTab={setActiveTab} 
              isPrivate={profile?.isPrivate} 
            />
            {activeTab === 'tags' && (
              <View style={{ paddingBottom: 20 }}>
                {bookmarks?.map((match: any) => (
                  <PostCard key={match.id} item={match} isDark={isDark} />
                ))}
                {(!bookmarks || bookmarks.length === 0) && !bookmarksLoading && (
                  <View style={{ alignItems: 'center', marginTop: 40 }}>
                    <Text style={{ color: isDark ? '#FFF' : '#616161', fontFamily: 'Urbanist-Medium' }}>No bookmarked battles yet.</Text>
                  </View>
                )}
              </View>
            )}
          </>
        }
      />
      <BottomNav backgroundColor={isDark ? Colors.dark.background : Colors.light.background} isDark={isDark} />
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 },
  errorText: { fontSize: 18, fontWeight: 'bold', marginBottom: 5, textAlign: 'center' },
  errorSubText: { fontSize: 14, color: 'gray', marginBottom: 20, textAlign: 'center' },
});

export default ProfilePage;
