import React, { useState, useEffect, useMemo } from 'react';
import { View, StyleSheet, SafeAreaView, Text, Button, FlatList, RefreshControl, ScrollView, useColorScheme } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useAuth } from '@/src/services/auth';
import { useProfile, useToggleFollow, useUserBookmarks, useUserMatches } from '@/src/hooks/useProfileData';
import ProfileHeader from '@/src/components/profile/ProfileHeader';
import Highlights from '@/src/components/profile/Highlights';
import ProfileTabs, { ProfileTab } from '@/src/components/profile/ProfileTabs';
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

  // Only needed to show the follow state on OTHER people's profiles — skip the
  // extra user read entirely when viewing your own profile.
  const { data: myProfile } = useProfile(isOwnProfile ? '' : (currentUser?.uid || ''));

  const isFollowing = useMemo(() => {
    return myProfile?.following?.includes(targetUserId) || false;
  }, [myProfile, targetUserId]);

  const { mutate: toggleFollow } = useToggleFollow();
  const [activeTab, setActiveTab] = useState<ProfileTab>('photo');

  // Lazy per-tab loading: only the active tab hits the network; already-loaded
  // tabs stay cached. Photo is the default so it loads on open.
  const { data: photoMatches, isLoading: photoLoading, refetch: refetchPhoto, isRefetching: photoRefetching } = useUserMatches(targetUserId, 'photo', activeTab === 'photo');
  const { data: videoMatches, isLoading: videoLoading, refetch: refetchVideo, isRefetching: videoRefetching } = useUserMatches(targetUserId, 'video', activeTab === 'video');
  const { data: bookmarks, isLoading: bookmarksLoading, refetch: refetchBookmarks } = useUserBookmarks(targetUserId, activeTab === 'tags');

  const handleToggleFollow = () => {
    if (!isOwnProfile) toggleFollow(targetUserId);
  };

  const handleRefresh = async () => {
    await Promise.all([refetchProfile(), refetchPhoto(), refetchVideo(), refetchBookmarks()]);
  };

  const bg = isDark ? Colors.dark.background : Colors.light.background;

  if (profileLoading && !profile) {
    return (
        <SafeAreaView style={[styles.container, { backgroundColor: bg }]}>
            <ScrollView showsVerticalScrollIndicator={false}>
                <ProfileHeaderSkeleton />
                <PostGridSkeleton />
            </ScrollView>
            <BottomNav backgroundColor={bg} isDark={isDark} />
        </SafeAreaView>
    );
  }

  // Current tab's battles (photo/video) or saved bookmarks.
  const currentData: any[] =
    activeTab === 'photo' ? (photoMatches || [])
    : activeTab === 'video' ? (videoMatches || [])
    : (bookmarks || []);
  const currentLoading =
    activeTab === 'photo' ? photoLoading
    : activeTab === 'video' ? videoLoading
    : bookmarksLoading;

  const emptyText =
    activeTab === 'photo' ? 'No photo battles yet.'
    : activeTab === 'video' ? 'No video battles yet.'
    : 'No saved battles yet.';

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: bg }]}>
      <FlatList
        data={currentData}
        keyExtractor={(item: any) => item.id}
        renderItem={({ item }) => <PostCard item={item} isDark={isDark} />}
        refreshControl={
          <RefreshControl
            refreshing={photoRefetching || videoRefetching}
            onRefresh={handleRefresh}
            tintColor="#FF4D67"
            colors={["#FF4D67"]}
          />
        }
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
              isPrivate={!!profile?.isPrivate}
            />
          </>
        }
        ListEmptyComponent={
          !currentLoading ? (
            <View style={{ alignItems: 'center', marginTop: 40 }}>
              <Text style={{ color: isDark ? '#FFF' : '#616161', fontFamily: 'Urbanist-Medium' }}>{emptyText}</Text>
            </View>
          ) : (
            <PostGridSkeleton />
          )
        }
        contentContainerStyle={{ paddingBottom: 100 }}
        showsVerticalScrollIndicator={false}
      />
      <BottomNav backgroundColor={bg} isDark={isDark} />
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
