import React, { useState, useEffect, useMemo } from 'react';
import { View, StyleSheet, SafeAreaView, Text, Button, ActivityIndicator, ScrollView } from 'react-native';
import { useRouter, useLocalSearchParams, usePathname } from 'expo-router';
import { useAuth } from '@/src/services/auth';
import { useProfile, useUserPosts, useToggleFollow } from '@/src/hooks/useProfileData';
import ProfileHeader from '@/src/components/profile/ProfileHeader';
import Highlights from '@/src/components/profile/Highlights';
import ProfileTabs from '@/src/components/profile/ProfileTabs';
import PostGrid from '@/src/components/profile/PostGrid';
import { ProfileHeaderSkeleton, PostGridSkeleton } from '@/src/components/profile/ProfileSkeleton';
import { WalletCard } from '@/src/components/profile/WalletCard';
import { BottomNav } from '@/src/components/home/BottomNav';
import { notificationService } from '@/src/services/notifications/notificationService';

const ProfilePage = () => {
  const router = useRouter();
  const { user: currentUser, loading: authLoading } = useAuth();
  const params = useLocalSearchParams();
  const pathname = usePathname();
  const userIdParam = params.userId as string | undefined;
  
  const [targetId, setTargetId] = useState<string | null>(null);
  const [isRedirecting, setIsRedirecting] = useState(false);

  useEffect(() => {
    if (!authLoading) {
        if (!currentUser) {
            // Unauthenticated user -> Redirect to Login
            setIsRedirecting(true);
            const redirectPath = userIdParam ? `/profile?userId=${userIdParam}` : '/profile';
            // Encode the redirect path
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
        <SafeAreaView style={styles.container}>
            <ScrollView showsVerticalScrollIndicator={false}>
                <ProfileHeaderSkeleton />
                <PostGridSkeleton />
            </ScrollView>
            <BottomNav backgroundColor="#fff" isDark={false} />
        </SafeAreaView>
    );
  }

  if (!targetId) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <Text style={styles.errorText}>User not found.</Text>
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

  const { 
    data: profile, 
    isLoading: profileLoading, 
    isError: isProfileError, 
    error: profileError,
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
  
  const { mutate: toggleFollow } = useToggleFollow();
  const [activeTab, setActiveTab] = useState<'posts' | 'reels' | 'tags'>('posts');

  const handleToggleFollow = () => {
    if (!isOwnProfile) toggleFollow(targetUserId);
  };

  const handleRefresh = async () => {
    await Promise.all([refetchProfile(), refetchPosts()]);
  };

  if (profileLoading && !profile) {
    return (
        <SafeAreaView style={styles.container}>
            <ScrollView showsVerticalScrollIndicator={false}>
                <ProfileHeaderSkeleton />
                <PostGridSkeleton />
            </ScrollView>
            <BottomNav backgroundColor="#fff" isDark={false} />
        </SafeAreaView>
    );
  }

  if (isProfileError || !profile) {
    return <SafeAreaView style={styles.container}><View style={styles.center}><Text>Error loading profile.</Text></View></SafeAreaView>;
  }

  const posts = postsData?.pages.flatMap(page => page.posts) || [];

  return (
    <SafeAreaView style={styles.container}>
      <PostGrid
        posts={activeTab === 'posts' ? posts : []}
        onLoadMore={() => hasNextPage && fetchNextPage()}
        isLoading={postsLoading}
        refreshing={isRefetching}
        onRefresh={handleRefresh}
        ListHeaderComponent={
          <>
            <ProfileHeader 
              user={profile} 
              isOwnProfile={isOwnProfile}
              onToggleFollow={handleToggleFollow}
              isFollowing={isFollowing}
            />
            {isOwnProfile && (
              <WalletCard 
                fishCoins={profile.fishCoins || 0} 
                stats={profile.stats || { contestsJoined: 0, wins: 0 }} 
                onPress={() => router.push('/wallet/store')} // LINKED HERE
              />
            )}
            <Highlights userId={targetUserId} />
            <ProfileTabs 
              activeTab={activeTab} 
              onChangeTab={setActiveTab} 
              isPrivate={profile.isPrivate} 
            />
          </>
        }
      />
      <BottomNav backgroundColor="#fff" isDark={false} />
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 },
  errorText: { fontSize: 18, fontWeight: 'bold', marginBottom: 5, textAlign: 'center' },
  errorSubText: { fontSize: 14, color: 'gray', marginBottom: 20, textAlign: 'center' },
});

export default ProfilePage;
