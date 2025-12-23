import React, { useState } from 'react';
import { View, StyleSheet, SafeAreaView, Text, Button, ActivityIndicator } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useAuth } from '@/src/services/auth';
import { useProfile, useUserPosts, useToggleFollow } from '@/src/hooks/useProfileData';
import ProfileHeader from '@/src/components/profile/ProfileHeader';
import Highlights from '@/src/components/profile/Highlights';
import ProfileTabs from '@/src/components/profile/ProfileTabs';
import PostGrid from '@/src/components/profile/PostGrid';
import { ProfileHeaderSkeleton, PostGridSkeleton } from '@/src/components/profile/ProfileSkeleton';
import { getAuth, signOut } from 'firebase/auth';

const ProfilePage = () => {
  const router = useRouter();
  const { user: currentUser, loading: authLoading } = useAuth();
  const params = useLocalSearchParams();
  const userIdParam = params.userId as string | undefined;
  
  const targetUserId = userIdParam || currentUser?.uid;

  // Show a loading screen while auth state is being determined or if we don't have a user ID yet
  if (authLoading || !targetUserId) {
    return (
      <SafeAreaView style={styles.container}>
        <ProfileHeaderSkeleton />
      </SafeAreaView>
    );
  }

  return <ProfileContent targetUserId={targetUserId} />;
};

const ProfileContent = ({ targetUserId }: { targetUserId: string }) => {
  const router = useRouter();
  const { user: currentUser } = useAuth();
  const isOwnProfile = currentUser?.uid === targetUserId;

  // Data fetching hooks
  const { data: profile, isLoading: profileLoading, error: profileError } = useProfile(targetUserId);
  const { 
    data: postsData, 
    isLoading: postsLoading, 
    fetchNextPage, 
    hasNextPage, 
    refetch, 
    isRefetching 
  } = useUserPosts(targetUserId);
  
  const { mutate: toggleFollow } = useToggleFollow();
  
  const [activeTab, setActiveTab] = useState<'posts' | 'reels' | 'tags'>('posts');

  const handleToggleFollow = () => {
    if (!isOwnProfile) {
      toggleFollow(targetUserId);
    }
  };

  // Main loading state for the initial profile fetch
  if (profileLoading) {
    return (
      <SafeAreaView style={styles.container}>
        <ProfileHeaderSkeleton />
        <PostGridSkeleton />
      </SafeAreaView>
    );
  }

  // Error state if the profile could not be fetched
  if (profileError || !profile) {
    console.error("Profile Page Error:", profileError);
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <Text style={styles.errorText}>Could not load profile.</Text>
          <Text style={styles.errorSubText}>{profileError?.message || 'The user may not exist.'}</Text>
          {isOwnProfile && (
            <Button title="Logout" onPress={async () => {
              await signOut(getAuth());
              router.replace('/auth/login');
            }} />
          )}
        </View>
      </SafeAreaView>
    );
  }

  const posts = postsData?.pages.flatMap(page => page.posts) || [];

  return (
    <SafeAreaView style={styles.container}>
      <PostGrid
        posts={activeTab === 'posts' ? posts : []}
        onLoadMore={() => hasNextPage && fetchNextPage()}
        isLoading={postsLoading}
        refreshing={isRefetching}
        onRefresh={refetch}
        ListHeaderComponent={
          <>
            <ProfileHeader 
              user={profile} 
              isOwnProfile={isOwnProfile}
              onToggleFollow={handleToggleFollow}
            />
            <Highlights />
            <ProfileTabs 
              activeTab={activeTab} 
              onChangeTab={setActiveTab} 
              isPrivate={profile.isPrivate} 
            />
          </>
        }
      />
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  errorText: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 5,
    textAlign: 'center',
  },
  errorSubText: {
    fontSize: 14,
    color: 'grey',
    marginBottom: 20,
    textAlign: 'center',
  },
});

export default ProfilePage;
