
import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
} from "react-native";
import { AppImage } from '@/src/components/ui/AppImage';
import { Alert } from '@/src/lib/appAlert';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { UserProfile } from '@/src/types/user';
import { Settings_Icon, ChatIcon_Light, ChatIcon_Dark } from '@/assets/svgs';
import { Ionicons } from '@/src/lib/icons';
import { useRouter } from 'expo-router';
import { isLevelInfo } from '@/src/lib/progression';
import { LevelProgressBar } from '@/src/components/gamification/LevelProgressBar';
import { ProfileFrame } from '@/src/components/gamification/ProfileFrame';
import { LevelBadge } from '@/src/components/gamification/LevelBadge';
import { useDesignWindow } from '@/src/lib/layout';
import type { PublicCosmetics } from '@/src/services/gamification';
import { startChat } from '@/src/services/messages/messageService';
import { useFeature } from '@/src/services/appSettings';
import { Colors } from '@/constants/theme';
import { UserActionsSheet } from '@/src/components/profile/UserActionsSheet';
import { useMutualFollowers, useUnblockUser } from '@/src/hooks/useProfileData';
import { useAuth } from '@/src/hooks/useAuth';
import { Avatar } from '@/src/components/ui/Avatar';
import { emitToast } from '@/src/lib/toastBridge';
import { reportError } from '@/src/lib/reportError';
import { VerifiedBadge } from '@/src/components/ui/VerifiedBadge';
import { useAuthGate } from '@/src/hooks/useAuthGate';
import { followButtonLabel, isFollowActive, type FollowState } from '@/src/lib/followState';


type ProfileHeaderProps = {
  user: UserProfile;
  isOwnProfile: boolean;
  onToggleFollow: () => void;
  isFollowing?: boolean; 
  /** Follow / Requested / Following. Wins over `isFollowing` when given. */
  followState?: FollowState;
  /**
   * A private account the viewer may not see behind (`profile.locked`): the
   * followers/following counts are shown but cannot be opened, as on Instagram.
   */
  connectionsLocked?: boolean;
  onRefresh?: () => void;
  /** They follow the viewer: shows a "Follows you" badge. */
  followsMe?: boolean;
  /** The viewer's own Restrict / Hide-story choices, for the ⋮ sheet. */
  isRestricted?: boolean;
  isStoryHidden?: boolean;
};

/**
 * A profile the viewer has blocked comes back from the Worker as a deliberately
 * minimal shell (`isBlockedByMe`) rather than a full profile or a 404 — the user
 * still has to be able to find the person in order to unblock them. Everything
 * except the identity and an Unblock button is suppressed.
 */
/**
 * "Followed by @a, @b and 3 others" — accounts the viewer follows that also
 * follow this profile. Hidden for guests and when there are none. Tapping opens
 * the profile's followers list.
 */
const MutualFollowersLine: React.FC<{ targetUserId: string; isDark: boolean; onOpen?: () => void }> = ({
  targetUserId,
  isDark,
  onOpen,
}) => {
  const { user: viewer } = useAuth();
  const { data } = useMutualFollowers(targetUserId, !!viewer);
  if (!data || data.count === 0) return null;
  const names = data.users.map((u) => `@${u.username || 'user'}`);
  const others = data.count - names.length;
  const text = others > 0 ? `${names.join(', ')} and ${others} other${others === 1 ? '' : 's'}` : names.join(' and ');
  return (
    <TouchableOpacity
      style={styles.mutualsRow}
      onPress={() => onOpen?.()}
      accessibilityRole="button"
      accessibilityLabel={`Followed by ${text}`}
    >
      <View style={styles.mutualsAvatars}>
        {data.users.map((u, i) => (
          <View key={u.uid} style={[styles.mutualAvatar, { marginLeft: i === 0 ? 0 : -8, borderColor: isDark ? '#181A20' : '#FFF' }]}>
            <Avatar uri={u.avatarUrl} name={u.username || 'user'} size={20} />
          </View>
        ))}
      </View>
      <Text style={[styles.mutualsText, { color: isDark ? '#BDBDBD' : '#666' }]} numberOfLines={2}>
        Followed by <Text style={styles.mutualsNames}>{text}</Text>
      </Text>
    </TouchableOpacity>
  );
};

const BlockedProfileNotice: React.FC<{
  user: UserProfile;
  isDark: boolean;
  onUnblock: () => void;
  busy: boolean;
}> = ({ user, isDark, onUnblock, busy }) => {
  const textColor = isDark ? Colors.dark.text : Colors.light.text;
  const secondary = isDark ? '#A0A0A0' : '#666';
  return (
    <View style={styles.blockedContainer}>
      <View style={[styles.blockedIcon, { backgroundColor: isDark ? '#1F222A' : '#F5F5F5' }]}>
        <Ionicons name="ban-outline" size={34} color="#FF4D67" />
      </View>
      <Text style={[styles.blockedTitle, { color: textColor }]}>@{user.username || 'user'} is blocked</Text>
      <Text style={[styles.blockedBody, { color: secondary }]}>
        You won&apos;t see each other&apos;s battles, stories or messages. Unblock to undo this — you will not
        start following each other again.
      </Text>
      <TouchableOpacity
        style={styles.blockedButton}
        onPress={onUnblock}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel={`Unblock ${user.username || 'user'}`}
      >
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.blockedButtonText}>Unblock</Text>}
      </TouchableOpacity>
    </View>
  );
};

const ProfileHeader: React.FC<ProfileHeaderProps> = ({
  user,
  isOwnProfile,
  onToggleFollow,
  isFollowing: isFollowingProp,
  followState,
  connectionsLocked,
  onRefresh,
  followsMe = false,
  isRestricted = false,
  isStoryHidden = false,
}) => {
  const state: FollowState = followState ?? (isFollowingProp ? 'following' : 'none');
  const isFollowing = isFollowActive(state);
  const { width: designW } = useDesignWindow();
  const { requireAuth } = useAuthGate();
  const router = useRouter();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;
  const textColor = isDark ? Colors.dark.text : Colors.light.text;
  
  const [isStartingChat, setIsStartingChat] = useState(false);
  const [actionsVisible, setActionsVisible] = useState(false);
  const [unblocking, setUnblocking] = useState(false);
  const chatEnabled = useFeature('chat'); // admin feature flag

  // Set by the Worker when the viewer has blocked this account (see the
  // BlockedProfileNotice comment above).
  const isBlockedByMe = !!(user as any)?.isBlockedByMe;
  const isMutedByMe = !!(user as any)?.isMutedByMe;
  const { mutateAsync: unblockUser } = useUnblockUser();

  const handleUnblock = async () => {
    if (unblocking) return;
    setUnblocking(true);
    try {
      await unblockUser(user.uid);
      emitToast(`Unblocked @${user.username || 'user'}.`, 'success');
      if (onRefresh) onRefresh();
    } catch (e: any) {
      reportError(e, { screen: 'profile-header', action: 'unblock', targetUserId: user.uid });
      emitToast(e?.message || 'Could not unblock. Please try again.', 'error');
    } finally {
      setUnblocking(false);
    }
  };

  // Level, progress and rank come from the server (`levelInfo`, computed by the
  // Worker's level engine). The app no longer runs its own copy of the formula:
  // that copy had the thresholds hardcoded and disagreed with the server as soon
  // as an admin changed them. Without a levelInfo (an older Worker) the badge
  // falls back to the server's `level` and no progress bar is drawn.
  const levelInfo = isLevelInfo((user as any).levelInfo) ? (user as any).levelInfo : null;
  const levelNumber = levelInfo?.level ?? (Number(user.level) || 1);
  const cosmetics = ((user as any).cosmetics ?? null) as PublicCosmetics | null;
  const titleText = cosmetics?.title?.text ?? levelInfo?.rank?.name ?? null;
  const equippedBadge = user.equippedBadge;

  const handleMessagePress = async () => {
    if (isStartingChat) return;
    // Guests can view the profile; messaging needs an account.
    if (!requireAuth('message')) return;
    setIsStartingChat(true);
    try {
        // Add a timeout to prevent infinite loading
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Request timed out')), 10000)
        );

        const chatPromise = startChat(user.uid, {
            displayName: user.fullName || user.username,
            photoURL: user.profileImageUrl
        });

        const chatId = await Promise.race([chatPromise, timeoutPromise]);
        
        setIsStartingChat(false);
        // Carry the recipient's identity so the chat header can render it —
        // there is no single-chat read endpoint to resolve it from the id.
        const chatQs = new URLSearchParams();
        const chatName = user.fullName || user.username;
        if (chatName) chatQs.set('name', chatName);
        if (user.profileImageUrl) chatQs.set('avatar', user.profileImageUrl);
        router.push(`/messages/chat/${chatId}?${chatQs.toString()}`);
    } catch (error: any) {
        console.error("Error starting chat:", error);
        setIsStartingChat(false);
        Alert.alert(
            "Error", 
            "Could not start chat. Please check your connection and try again.\n" + (error.message || "")
        );
    }
  };

  const profileImage = user.profileImageUrl ? { uri: user.profileImageUrl } : require('@/assets/images/userLight.png');

  const navigateToConnections = (type: 'followers' | 'following') => {
    // Locked behind a private account: the server would answer an empty list.
    if (connectionsLocked) return;
    router.push({
      pathname: '/profile/connections',
      params: { userId: user.uid, type },
    });
  };

  // A blocked profile renders the notice INSTEAD of the profile. Falling through
  // would mean reading stats, XP and badges off the shell, which is all zeroes —
  // showing someone a fake empty profile is worse than showing them the reason.
  if (isBlockedByMe) {
    return (
      <View style={[styles.container, { backgroundColor }]}>
        <View style={styles.topBar}>
          <View style={styles.topBarLeft} />
          <Text style={[styles.usernameText, { color: textColor }]}>@{user.username || 'username'}</Text>
          <View style={styles.topBarRight} />
        </View>
        <BlockedProfileNotice user={user} isDark={isDark} onUnblock={handleUnblock} busy={unblocking} />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor }]}>
      <View style={styles.topBar}>
        <View style={styles.topBarLeft} />
        <View style={styles.titleRow}>
          <Text style={[styles.usernameText, { color: textColor }]} numberOfLines={1}>
            @{user.username || 'username'}
          </Text>
          <VerifiedBadge verified={user.verified} size={16} />
        </View>
        <View style={styles.topBarRight}>
           {isOwnProfile ? (
             <TouchableOpacity onPress={() => router.push('/setting')}><Settings_Icon width={24} height={24} color={textColor} /></TouchableOpacity>
           ) : (
             // This slot was empty on other people's profiles, which is why there
             // was nowhere to put Block / Mute / Report.
             <TouchableOpacity
               onPress={() => requireAuth('report') && setActionsVisible(true)}
               accessibilityRole="button"
               accessibilityLabel="More options"
               accessibilityHint="Block, mute or report this account"
               hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
             >
               <Ionicons name="ellipsis-vertical" size={22} color={textColor} />
             </TouchableOpacity>
           )}
        </View>
      </View>

      {!isOwnProfile && (
        <UserActionsSheet
          visible={actionsVisible}
          onClose={() => setActionsVisible(false)}
          targetUserId={user.uid}
          username={user.username}
          photoUrl={user.profileImageUrl || null}
          isBlocked={isBlockedByMe}
          isMuted={isMutedByMe}
          isRestricted={isRestricted}
          isStoryHidden={isStoryHidden}
          isDark={isDark}
        />
      )}

      <View style={styles.avatarWrapper}>
        <ProfileFrame frame={cosmetics?.frame ?? null} size={100} fallbackBorder={equippedBadge ? '#FFD700' : isDark ? '#35383F' : '#eee'}>
          <View style={[styles.avatarInner, { backgroundColor }]}>
            <AppImage source={profileImage} displayWidth={100} style={styles.avatarImage} contentFit="cover" />
          </View>
        </ProfileFrame>
        {equippedBadge && (
            <View style={[styles.equippedBadgeIcon, { backgroundColor }]}>
                <Ionicons name="trophy" size={18} color="#FFD700" />
            </View>
        )}
        {/* The server's level on the rank's emblem (one component for every level). */}
        <View style={styles.levelBadge}>
          <LevelBadge
            level={levelNumber}
            rankId={levelInfo?.rank?.id}
            rankName={levelInfo?.rank?.name}
            isMaxLevel={!!levelInfo?.isMaxLevel}
            size={designW >= 600 ? 'md' : 'sm'}
          />
        </View>
      </View>

      <View style={styles.infoSection}>
        <View style={styles.nameRow}>
          <Text style={[styles.fullNameText, { color: textColor }]} numberOfLines={1}>
            {user.fullName || user.username}
          </Text>
          <VerifiedBadge verified={user.verified} size={20} />
        </View>
        {titleText ? (
          <View style={styles.rankRow} accessibilityLabel={`Rank ${titleText}`}>
            <Ionicons name={levelInfo?.rank?.icon || 'star'} size={13} color={levelInfo?.rank?.color || '#FFB300'} />
            <Text style={[styles.rankText, { color: levelInfo?.rank?.color || '#FFB300' }]}>{titleText}</Text>
          </View>
        ) : null}
        {cosmetics?.pinned?.length ? (
          <View style={styles.pinnedRow} accessibilityLabel={`Pinned achievements: ${cosmetics.pinned.map((a) => a.name).join(', ')}`}>
            {cosmetics.pinned.map((a) => (
              <View key={a.id} style={[styles.pinnedChip, { backgroundColor: isDark ? '#1F222A' : '#FFF5E6' }]}>
                <Ionicons name={a.icon || 'trophy'} size={12} color="#FFB300" />
                <Text style={[styles.pinnedText, { color: textColor }]} numberOfLines={1}>{a.name}</Text>
              </View>
            ))}
          </View>
        ) : null}
        {!isOwnProfile && followsMe && (
          <View style={[styles.followsYouPill, { backgroundColor: isDark ? '#2A2D35' : '#F1F1F4' }]} accessibilityLabel="Follows you">
            <Text style={[styles.followsYouText, { color: isDark ? '#D0D0D0' : '#555' }]}>Follows you</Text>
          </View>
        )}
        {user.bio ? <Text style={[styles.bioText, { color: isDark ? '#E0E0E0' : '#666' }]}>{user.bio}</Text> : null}
        {!isOwnProfile && (
          <MutualFollowersLine targetUserId={user.uid} isDark={isDark} onOpen={() => navigateToConnections('followers')} />
        )}
      </View>
      
      {/* ACTION BUTTONS (Edit Profile vs Follow/Message) */}
      <View style={styles.actionButtonsContainer}>
        {isOwnProfile ? (
            <TouchableOpacity style={[styles.editProfileButton, { backgroundColor, borderColor: isDark ? '#35383F' : '#DDD' }]} onPress={() => router.push('/profile/manage/edit')}>
                <Text style={[styles.editProfileText, { color: textColor }]}>Edit Profile</Text>
            </TouchableOpacity>
        ) : (
            <View style={styles.userActionButtons}>
                <TouchableOpacity 
                    style={[styles.followButton, isFollowing && styles.followingButton, isFollowing && { backgroundColor, borderColor: isDark ? '#35383F' : '#DDD' }]} 
                    onPress={onToggleFollow}
                    accessibilityRole="button"
                    accessibilityLabel={state === 'requested' ? 'Requested. Tap to cancel the follow request' : followButtonLabel(state)}
                >
                    <Text style={[styles.followButtonText, isFollowing && { color: textColor }]}>
                        {followButtonLabel(state)}
                    </Text>
                </TouchableOpacity>
                
                {chatEnabled && (
                <TouchableOpacity 
                    style={[styles.messageButton, { backgroundColor: isDark ? '#1F222A' : '#F5F5F5' }]} 
                    onPress={handleMessagePress}
                    disabled={isStartingChat}
                >
                    {isStartingChat ? <ActivityIndicator size="small" color={textColor} /> : <Text style={[styles.messageButtonText, { color: textColor }]}>Message</Text>}
                </TouchableOpacity>
                )}
            </View>
        )}
      </View>

      <View style={styles.statsRow}>
        <View style={styles.statItem}><Text style={[styles.statValue, { color: textColor }]}>{(user as any).postsCount || 0}</Text><Text style={[styles.statLabel, { color: isDark ? '#BDBDBD' : '#666' }]}>Post</Text></View>
        
        <TouchableOpacity style={styles.statItem} onPress={() => navigateToConnections('followers')}>
          <Text style={[styles.statValue, { color: textColor }]}>{(user as any).followersCount || 0}</Text>
          <Text style={[styles.statLabel, { color: isDark ? '#BDBDBD' : '#666' }]}>Followers</Text>
        </TouchableOpacity>
        
        <TouchableOpacity style={styles.statItem} onPress={() => navigateToConnections('following')}>
          <Text style={[styles.statValue, { color: textColor }]}>{(user as any).followingCount || 0}</Text>
          <Text style={[styles.statLabel, { color: isDark ? '#BDBDBD' : '#666' }]}>Following</Text>
        </TouchableOpacity>
      </View>
      
      {/* XP / level bar — server-computed (worker lib/progression.ts#levelInfo) */}
      {levelInfo ? (
        <View style={styles.xpContainer}>
          <LevelProgressBar info={levelInfo} isDark={isDark} />
          {isOwnProfile ? (
            <TouchableOpacity
              style={styles.rewardsLink}
              onPress={() => router.push('/rewards' as any)}
              accessibilityRole="button"
              accessibilityLabel="Open Level and Rewards"
            >
              <Ionicons name="gift-outline" size={14} color="#FF4D67" />
              <Text style={styles.rewardsLinkText} numberOfLines={1}>
                {levelInfo.isMaxLevel
                  ? 'Max level reached · Level & Rewards'
                  : levelInfo.nextMilestone
                    ? `Next unlock: Level ${levelInfo.nextMilestone.level} · ${levelInfo.nextMilestone.title}`
                    : 'Level & Rewards'}
              </Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}

    </View>
  );
};

const styles = StyleSheet.create({
  container: { paddingBottom: 20 },
  topBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, height: 56 },
  topBarLeft: { width: 40 },
  topBarRight: { width: 40, alignItems: 'flex-end' },
  usernameText: { fontSize: 18, fontFamily: 'Urbanist-Bold', flexShrink: 1 },
  titleRow: { flexDirection: 'row', alignItems: 'center', flex: 1, justifyContent: 'center' },
  nameRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', maxWidth: '100%' },
  avatarWrapper: { alignSelf: 'center', marginTop: 10, position: 'relative' },
  avatarInner: { width: 100, height: 100, borderRadius: 50, overflow: 'hidden' },
  avatarImage: { width: 100, height: 100, borderRadius: 50 },
  levelBadge: { position: 'absolute', bottom: -8, alignSelf: 'center' },
  equippedBadgeIcon: { position: 'absolute', top: -5, left: -5, borderRadius: 15, width: 30, height: 30, justifyContent: 'center', alignItems: 'center', elevation: 3, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 2 },
  infoSection: { alignItems: 'center', marginTop: 15, paddingHorizontal: 20 },
  fullNameText: { fontSize: 22, fontFamily: 'Urbanist-Bold' },
  bioText: { fontSize: 14, textAlign: 'center', marginTop: 8, fontFamily: 'Urbanist-Regular' },
  followsYouPill: { alignSelf: 'center', marginTop: 6, paddingHorizontal: 10, paddingVertical: 3, borderRadius: 10 },
  followsYouText: { fontSize: 12, fontFamily: 'Urbanist-SemiBold' },
  mutualsRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: 10, paddingHorizontal: 24, gap: 8 },
  mutualsAvatars: { flexDirection: 'row' },
  mutualAvatar: { borderWidth: 1.5, borderRadius: 12, overflow: 'hidden' },
  mutualsText: { flexShrink: 1, fontSize: 12, fontFamily: 'Urbanist-Regular' },
  mutualsNames: { fontFamily: 'Urbanist-SemiBold' },
  
  // Action Buttons
  actionButtonsContainer: { marginTop: 20, paddingHorizontal: 20, alignItems: 'center' },
  editProfileButton: { paddingVertical: 10, paddingHorizontal: 24, borderRadius: 20, borderWidth: 1 },
  editProfileText: { fontSize: 14, fontFamily: 'Urbanist-Bold' },
  
  userActionButtons: { flexDirection: 'row', gap: 12 },
  followButton: { paddingVertical: 10, paddingHorizontal: 32, borderRadius: 24, backgroundColor: '#FF4D67' },
  followingButton: { borderWidth: 1 },
  followButtonText: { color: '#FFF', fontFamily: 'Urbanist-Bold', fontSize: 14 },
  
  messageButton: { paddingVertical: 10, paddingHorizontal: 32, borderRadius: 24 },
  messageButtonText: { fontFamily: 'Urbanist-Bold', fontSize: 14 },

  // Blocked-profile notice
  blockedContainer: { alignItems: 'center', paddingHorizontal: 32, paddingTop: 40, paddingBottom: 24 },
  blockedIcon: { width: 76, height: 76, borderRadius: 38, justifyContent: 'center', alignItems: 'center' },
  blockedTitle: { fontFamily: 'Urbanist-Bold', fontSize: 20, marginTop: 20, textAlign: 'center' },
  blockedBody: { fontFamily: 'Urbanist-Regular', fontSize: 14, textAlign: 'center', marginTop: 10, lineHeight: 20 },
  blockedButton: { marginTop: 24, backgroundColor: '#FF4D67', paddingVertical: 12, paddingHorizontal: 40, borderRadius: 24, minWidth: 160, alignItems: 'center' },
  blockedButtonText: { color: '#fff', fontFamily: 'Urbanist-Bold', fontSize: 15 },

  xpContainer: { marginTop: 20, paddingHorizontal: 30, width: '100%' },
  rewardsLink: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10, alignSelf: 'center', paddingVertical: 4, paddingHorizontal: 8 },
  rewardsLinkText: { color: '#FF4D67', fontFamily: 'Urbanist-SemiBold', fontSize: 12, flexShrink: 1 },
  rankRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
  rankText: { fontSize: 13, fontFamily: 'Urbanist-Bold' },
  pinnedRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 6, marginTop: 8 },
  pinnedChip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, maxWidth: 140 },
  pinnedText: { fontSize: 11, fontFamily: 'Urbanist-SemiBold', flexShrink: 1 },
  statsRow: { flexDirection: 'row', justifyContent: 'space-around', marginTop: 25 },
  statItem: { alignItems: 'center', flex: 1 },
  statValue: { fontSize: 20, fontFamily: 'Urbanist-Bold' },
  statLabel: { fontSize: 13, marginTop: 4, fontFamily: 'Urbanist-Medium' },
  
});

export default ProfileHeader;
