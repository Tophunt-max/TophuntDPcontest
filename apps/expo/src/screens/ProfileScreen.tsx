import React, { useState, useEffect, useMemo } from 'react';
import {
  View,
  StyleSheet,
  SafeAreaView,
  Text,
  Button,
  FlatList,
  Platform,
  RefreshControl,
  ScrollView,
} from 'react-native';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useAuth } from '@/src/services/auth';
import { useProfile, useToggleFollow, useUserBookmarks, useUserMatches } from '@/src/hooks/useProfileData';
import ProfileHeader from '@/src/components/profile/ProfileHeader';
import Highlights from '@/src/components/profile/Highlights';
import ProfileTabs, { ProfileTab } from '@/src/components/profile/ProfileTabs';
import { ProfileHeaderSkeleton, PostGridSkeleton } from '@/src/components/profile/ProfileSkeleton';
import { WalletCard } from '@/src/components/profile/WalletCard';
import { PrizeEntryCard } from '@/src/components/prizes/PrizeEntryCard';
import { BottomNav } from '@/src/components/home/BottomNav';
import { notificationService } from '@/src/services/notifications/notificationService';
import { fetchProfileByHandle, profilePath } from '@/src/services/users';
import { Colors } from '@/constants/theme';
import { PostCard } from '@/src/components/home/PostCard';

interface ProfileScreenProps {
  /**
   * The handle from the public `/@username` url, without the `@`.
   *
   * When set, the profile is addressed by HANDLE rather than by uid. That is the
   * canonical public address: `?userId=<uid>` put the internal Firebase uid into
   * every shared link, browser history entry and clipboard, and an internal
   * identifier does not belong in a url a user is meant to share.
   */
  handle?: string;
}

const ProfilePage = ({ handle }: ProfileScreenProps) => {
  const router = useRouter();
  const { user: currentUser, loading: authLoading } = useAuth();
  const params = useLocalSearchParams();
  const userIdParam = params.userId as string | undefined;
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;

  const [targetId, setTargetId] = useState<string | null>(null);
  const [isRedirecting, setIsRedirecting] = useState(false);
  /**
   * How a `/@handle` lookup ended, when it did not produce a profile.
   *
   * Tracked separately from `targetId` so those states are reachable at all — without
   * it an unresolved handle would sit on the loading skeleton forever, which reads as a
   * hang rather than an answer.
   *
   * `'missing'` and `'unavailable'` are kept apart on purpose: telling someone who
   * followed a link that the account does not exist, when in fact the request failed,
   * is both wrong and unactionable. The edge Worker draws the same distinction (404 vs
   * 503) for the same reason.
   */
  const [handleOutcome, setHandleOutcome] = useState<'missing' | 'unavailable' | null>(null);
  /**
   * Bumped by "Try Again". Needed because none of the resolution effect's other
   * dependencies change on a retry — clearing `handleOutcome` alone would leave the
   * visitor on the skeleton with nothing in flight.
   */
  const [retryNonce, setRetryNonce] = useState(0);

  // --- addressed by handle: /@username ------------------------------------
  useEffect(() => {
    if (!handle) return;
    if (authLoading) return;
    /**
     * Same sign-in gate the uid address has always had.
     *
     * Deliberately NOT relaxed as part of this change. Making `/@username` viewable
     * without an account would be a separate, much larger decision — every profile
     * becomes readable by anyone on the internet — and it is not what moving the uid
     * out of the url required. The url is the change; who may read a profile is
     * unchanged.
     *
     * `redirect` carries the handle, so signing in lands back on the profile the
     * visitor actually followed a link to.
     */
    if (!currentUser) {
      setIsRedirecting(true);
      router.replace(`/auth/login?redirect=${encodeURIComponent(`/@${handle}`)}`);
      return;
    }

    /**
     * ONE url per profile, in the app as well as at the edge.
     *
     * The edge Worker 301s `/@Alice` to `/@alice`, but that only runs on a hard
     * navigation. A handle reached by in-app routing never touches it, so without this
     * the address bar keeps whatever casing the link had — and that is the string the
     * user copies out of the app. Web only: on native there is no address bar to fix.
     */
    if (Platform.OS === 'web') {
      const lower = handle.toLowerCase();
      if (lower !== handle) {
        router.replace(`/@${lower}`);
        return;
      }
    }

    let cancelled = false;
    setHandleOutcome(null);
    (async () => {
      const resolved = await fetchProfileByHandle(handle);
      if (cancelled) return;

      // The handle was released and the account renamed. Send the reader to the current
      // handle so an old link still lands on the right person, instead of dying the way
      // a renamed Instagram handle does.
      if (resolved.status === 'moved') {
        const next = profilePath(resolved.movedTo);
        if (next) router.replace(next);
        else setHandleOutcome('missing');
        return;
      }

      if (resolved.status === 'unavailable') {
        setHandleOutcome('unavailable');
        return;
      }

      const uid = resolved.status === 'found' ? resolved.profile?.uid : null;
      if (!uid) {
        setHandleOutcome('missing');
        return;
      }
      setTargetId(uid);
      if (uid !== currentUser?.uid) notificationService.notifyProfileVisit(uid);
    })();
    return () => {
      cancelled = true;
    };
  }, [handle, authLoading, currentUser, router, retryNonce]);

  // --- addressed by uid: /profile and /profile?userId=<uid> ----------------
  useEffect(() => {
    if (handle) return;
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
  }, [handle, authLoading, userIdParam, currentUser, router]);

  /**
   * A handle that produced no profile. Checked BEFORE the loading branch below, which
   * would otherwise match (`!targetId`) and leave the visitor on the skeleton forever —
   * a hang rather than an answer.
   *
   * Two outcomes, two messages, and the difference matters to the person reading it.
   * "Doesn't exist" is a dead end and offers a way out; a failed request is temporary
   * and offers a retry. Showing the first for the second is how a visitor abandons a
   * link that would have worked a moment later.
   */
  if (handleOutcome) {
    const unavailable = handleOutcome === 'unavailable';
    return (
      <SafeAreaView style={[styles.container, { backgroundColor }]}>
        <View style={styles.center}>
          <Text style={[styles.errorText, { color: isDark ? '#fff' : '#000' }]}>
            {unavailable ? 'Couldn\u2019t load this profile' : 'User not available'}
          </Text>
          <Text style={styles.errorSubText}>
            {unavailable
              ? 'Check your connection and try again.'
              : 'This account doesn\u2019t exist or is no longer available.'}
          </Text>
          {unavailable ? (
            // Bumping the nonce re-runs the resolution effect, which clears the outcome
            // itself — a genuine retry rather than a full reload.
            <Button title="Try Again" onPress={() => setRetryNonce((n) => n + 1)} />
          ) : (
            <Button title="Go Home" onPress={() => router.replace('/home')} />
          )}
        </View>
        <BottomNav backgroundColor={backgroundColor} isDark={isDark} />
      </SafeAreaView>
    );
  }

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

  // `addressedByUid` tells the content to rewrite the url once it knows the handle.
  return <ProfileContent targetUserId={targetId} addressedByUid={!handle && !!userIdParam} />;
};

const ProfileContent = ({
  targetUserId,
  addressedByUid,
}: {
  targetUserId: string;
  /** True when this was reached via `?userId=<uid>` and the url should be canonicalised. */
  addressedByUid?: boolean;
}) => {
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
  const [selectedTab, setSelectedTab] = useState<ProfileTab>('photo');

  // "Saved" only exists on your own profile. If the screen is reused for another
  // user while that tab was open, fall back to Photo instead of showing a tab
  // that is no longer rendered.
  const activeTab: ProfileTab = selectedTab === 'tags' && !isOwnProfile ? 'photo' : selectedTab;

  // Lazy per-tab loading: only the active tab hits the network; already-loaded
  // tabs stay cached. Photo is the default so it loads on open.
  const { data: photoMatches, isLoading: photoLoading, refetch: refetchPhoto, isRefetching: photoRefetching } = useUserMatches(targetUserId, 'photo', activeTab === 'photo');
  const { data: videoMatches, isLoading: videoLoading, refetch: refetchVideo, isRefetching: videoRefetching } = useUserMatches(targetUserId, 'video', activeTab === 'video');
  // Bookmarks are private to their owner — only ever request your own.
  const { data: bookmarks, isLoading: bookmarksLoading, refetch: refetchBookmarks } = useUserBookmarks(targetUserId, activeTab === 'tags' && isOwnProfile);

  /**
   * Rewrite `?userId=<uid>` to the canonical `/@handle` once the handle is known.
   *
   * This is what actually keeps the internal Firebase uid out of the address bar,
   * browser history and anything the reader copies — the in-app navigation sites
   * still push `?userId=` because most of them only hold a uid, and canonicalising
   * here fixes all of them at once instead of needing every call site to look a
   * handle up first.
   *
   * WEB ONLY. On native the url is not user-visible, and `router.replace` would
   * rewrite the navigation stack for no benefit — it would also fight the back
   * gesture, since the entry being replaced is the one the user came from.
   *
   * Cannot loop: the replacement carries no `userId`, so `addressedByUid` is false on
   * the route that follows.
   */
  useEffect(() => {
    if (!addressedByUid) return;
    if (Platform.OS !== 'web') return;
    const next = profilePath(profile?.username);
    if (next) router.replace(next);
  }, [addressedByUid, profile?.username, router]);

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

  // The profile could not be loaded. Previously this fell through to
  // `<ProfileHeader user={profile!} />` with `profile` undefined, which crashed on
  // the first property read — the non-null assertion was hiding a real state.
  //
  // Reachable whenever the account does not exist AND, now, when the account has
  // blocked the viewer: the Worker deliberately reports that case as
  // indistinguishable from a nonexistent user, so that the person who was blocked
  // cannot learn that they were. The wording here has to work for both.
  // Deliberately `!profile` and NOT `isError`. React Query keeps `data` and sets
  // `isError` on a failed BACKGROUND refetch, so keying this on the error flag
  // would replace a perfectly good loaded profile with "User not available" after
  // a single flaky pull-to-refresh. A genuinely absent profile throws rather than
  // resolving undefined, so `!profile` already covers both real cases.
  if (!profile) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: bg }]}>
        <View style={styles.center}>
          <Text style={[styles.errorText, { color: isDark ? '#fff' : '#000' }]}>User not available</Text>
          <Text style={styles.errorSubText}>This account doesn&apos;t exist or is no longer available.</Text>
          <Button title="Go Home" onPress={() => router.replace('/home')} />
        </View>
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

  // Set by the Worker on a profile the viewer has blocked.
  const isBlockedByMe = !!(profile as any)?.isBlockedByMe;

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: bg }]}>
      <FlatList
        data={isBlockedByMe ? [] : currentData}
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
              user={profile}
              isOwnProfile={isOwnProfile}
              onToggleFollow={handleToggleFollow}
              isFollowing={isFollowing}
              onRefresh={handleRefresh}
            />
            {/*
              A blocked profile renders as a notice plus an Unblock button and
              nothing else. The server already returns empty lists for every
              sub-resource, so leaving the tabs mounted would show a row of tabs
              over a permanently empty grid and read as a loading failure.
            */}
            {isBlockedByMe ? null : (
            <>
            {isOwnProfile && (
              <>
                <WalletCard
                  Dpcoin={profile?.Dpcoin || 0}
                  stats={profile?.stats || { contestsJoined: 0, wins: 0, totalVotesReceived: 0 }}
                  onPress={() => router.push('/wallet')}
                  onPressWins={() => router.push(`/profile/wins?userId=${targetUserId}`)}
                />
                {/*
                  Physical prizes have no home in the WalletCard — they are not coins
                  and never touch a balance. This renders nothing at all for a user
                  who has never won one, and turns into a call to action when one is
                  waiting on their delivery address.
                */}
                <PrizeEntryCard isDark={isDark} />
              </>
            )}
            <Highlights userId={targetUserId} />
            <ProfileTabs
              activeTab={activeTab}
              onChangeTab={setSelectedTab}
              isPrivate={!!profile?.isPrivate}
              showSaved={isOwnProfile}
            />
            </>
            )}
          </>
        }
        ListEmptyComponent={
          isBlockedByMe ? null : !currentLoading ? (
            <View style={{ alignItems: 'center', marginTop: 40 }}>
              <Text style={{ color: isDark ? '#FFF' : '#616161', fontFamily: 'Urbanist-Medium' }}>{emptyText}</Text>
            </View>
          ) : (
            <PostGridSkeleton />
          )
        }
        contentContainerStyle={{ paddingBottom: 100 }}
        showsVerticalScrollIndicator={false}
        removeClippedSubviews
        initialNumToRender={4}
        maxToRenderPerBatch={5}
        windowSize={7}
        updateCellsBatchingPeriod={50}
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
