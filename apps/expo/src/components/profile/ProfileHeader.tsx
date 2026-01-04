import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, Image, TouchableOpacity, Modal, Dimensions, ActivityIndicator, Alert, useColorScheme } from 'react-native';
import { UserProfile, Badge } from '@/src/types/user';
import { Settings_Icon, ChatIcon_Light, ChatIcon_Dark } from '@/assets/svgs';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { equipBadgeService } from '@/src/services/users';
import Animated, { useSharedValue, useAnimatedStyle, withSpring, withRepeat, withTiming, Easing } from 'react-native-reanimated';
import { startChat } from '@/src/services/messages/messageService';
import { Colors } from '@/constants/theme';

const { width } = Dimensions.get('window');

type ProfileHeaderProps = {
  user: UserProfile;
  isOwnProfile: boolean;
  onToggleFollow: () => void;
  isFollowing?: boolean; 
  onRefresh?: () => void;
};

const calculateLevelInfo = (xp: number) => {
    let level = 1;
    let threshold = 500;
    let accumulatedXp = 0;
    while (xp >= accumulatedXp + threshold) {
        accumulatedXp += threshold;
        level++;
        threshold += 500; 
    }
    const nextLevelThreshold = threshold;
    const currentLevelProgress = xp - accumulatedXp;
    const percentage = (currentLevelProgress / nextLevelThreshold) * 100;
    return { level, progressXp: currentLevelProgress, nextLevelXp: nextLevelThreshold, percentage: Math.min(percentage, 100) };
};

const ProfileHeader: React.FC<ProfileHeaderProps> = ({ user, isOwnProfile, onToggleFollow, isFollowing, onRefresh }) => {
  const router = useRouter();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;
  const textColor = isDark ? Colors.dark.text : Colors.light.text;
  
  const [claimModalVisible, setClaimModalVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  const [canClaim, setCanClaim] = useState(false);
  const [isStartingChat, setIsStartingChat] = useState(false);
  
  const xp = user.xp || 0;
  const levelInfo = calculateLevelInfo(xp);
  const equippedBadge = user.equippedBadge;

  // Animation shared values
  const badgeScale = useSharedValue(0);
  const claimBtnScale = useSharedValue(1);

  useEffect(() => {
    // Logic: If progress is >= 99% and there's an unclaimed badge for this level
    // In a real app, you'd check if user.badges already contains this level's badge
    const hasBadgeForCurrentLevel = user.badges?.some(b => b.level === levelInfo.level);
    if (levelInfo.percentage >= 99 && !hasBadgeForCurrentLevel && isOwnProfile) {
        setCanClaim(true);
        claimBtnScale.value = withRepeat(withSpring(1.1), -1, true);
    } else {
        setCanClaim(false);
    }
  }, [levelInfo.percentage, user.badges]);

  const animatedBadgeStyle = useAnimatedStyle(() => ({
    transform: [{ scale: badgeScale.value }]
  }));

  const animatedClaimBtnStyle = useAnimatedStyle(() => ({
    transform: [{ scale: claimBtnScale.value }]
  }));

  const handleClaim = () => {
    setClaimModalVisible(true);
    badgeScale.value = withSpring(1, { damping: 10, stiffness: 100 });
  };

  const confirmClaim = async () => {
    setLoading(true);
    // In reality, this would call a backend function to 'claim' and add to user.badges
    // For now, we simulate equipping it
    try {
        const newBadge: Badge = { name: `Level ${levelInfo.level} Hero`, icon: '🏆', level: levelInfo.level };
        await equipBadgeService(user.uid, newBadge);
        setClaimModalVisible(false);
        if (onRefresh) onRefresh();
    } catch (error) {
        console.error(error);
        Alert.alert('Error', 'Failed to claim badge. Please try again.');
    } finally {
        setLoading(false);
    }
  };

  const handleMessagePress = async () => {
    if (isStartingChat) return;
    setIsStartingChat(true);
    try {
        // Add a timeout to prevent infinite loading
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Request timed out')), 10000)
        );

        const chatPromise = startChat(user.uid, {
            displayName: user.displayName || user.username,
            photoURL: user.profileImageUrl
        });

        const chatId = await Promise.race([chatPromise, timeoutPromise]);
        
        setIsStartingChat(false);
        router.push(`/messages/chat/${chatId}`);
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

  return (
    <View style={[styles.container, { backgroundColor }]}>
      <View style={styles.topBar}>
        <View style={styles.topBarLeft} />
        <Text style={[styles.usernameText, { color: textColor }]}>@{user.username || 'username'}</Text>
        <View style={styles.topBarRight}>
           {isOwnProfile && <TouchableOpacity onPress={() => router.push('/setting')}><Settings_Icon width={24} height={24} color={textColor} /></TouchableOpacity>}
        </View>
      </View>

      <View style={styles.avatarWrapper}>
        <View style={[styles.avatarBorder, { backgroundColor, borderColor: isDark ? '#35383F' : '#eee' }, equippedBadge && { borderColor: '#FFD700', borderWidth: 3 }]}>
          <Image source={profileImage} style={styles.avatarImage} resizeMode="cover" />
        </View>
        {equippedBadge && (
            <View style={[styles.equippedBadgeIcon, { backgroundColor }]}>
                <Text style={{fontSize: 20}}>{equippedBadge.icon}</Text>
            </View>
        )}
        <LinearGradient colors={['#FFD700', '#FFA500']} style={styles.levelBadge}>
            <Text style={styles.levelText}>Lv. {levelInfo.level}</Text>
        </LinearGradient>
      </View>

      <View style={styles.infoSection}>
        <Text style={[styles.fullNameText, { color: textColor }]}>{user.fullName || user.username}</Text>
        {user.bio ? <Text style={[styles.bioText, { color: isDark ? '#E0E0E0' : '#666' }]}>{user.bio}</Text> : null}
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
                >
                    <Text style={[styles.followButtonText, isFollowing && { color: textColor }]}>
                        {isFollowing ? 'Following' : 'Follow'}
                    </Text>
                </TouchableOpacity>
                
                <TouchableOpacity 
                    style={[styles.messageButton, { backgroundColor: isDark ? '#1F222A' : '#F5F5F5' }]} 
                    onPress={handleMessagePress}
                    disabled={isStartingChat}
                >
                    {isStartingChat ? <ActivityIndicator size="small" color={textColor} /> : <Text style={[styles.messageButtonText, { color: textColor }]}>Message</Text>}
                </TouchableOpacity>
            </View>
        )}
      </View>

      <View style={styles.statsRow}>
        <View style={styles.statItem}><Text style={[styles.statValue, { color: textColor }]}>{(user as any).postsCount || 0}</Text><Text style={[styles.statLabel, { color: isDark ? '#BDBDBD' : '#666' }]}>Post</Text></View>
        <View style={styles.statItem}><Text style={[styles.statValue, { color: textColor }]}>{(user as any).followersCount || 0}</Text><Text style={[styles.statLabel, { color: isDark ? '#BDBDBD' : '#666' }]}>Followers</Text></View>
        <View style={styles.statItem}><Text style={[styles.statValue, { color: textColor }]}>{(user as any).followingCount || 0}</Text><Text style={[styles.statLabel, { color: isDark ? '#BDBDBD' : '#666' }]}>Following</Text></View>
      </View>
      
      {/* XP/Level Bar */}
      <View style={styles.xpContainer}>
        <View style={styles.xpHeader}>
            <Text style={styles.xpLabel}>Level {levelInfo.level} Progress</Text>
            <Text style={[styles.xpValue, { color: isDark ? '#BDBDBD' : '#888' }]}>{Math.floor(levelInfo.progressXp)} / {levelInfo.nextLevelXp} XP</Text>
        </View>
        
        {canClaim && isOwnProfile ? (
            <Animated.View style={animatedClaimBtnStyle}>
                <TouchableOpacity onPress={handleClaim}>
                    <LinearGradient colors={['#FFD700', '#FF8C00']} style={styles.claimButton}>
                        <Text style={styles.claimButtonText}>🎁 CLAIM LEVEL BADGE</Text>
                    </LinearGradient>
                </TouchableOpacity>
            </Animated.View>
        ) : (
            <View style={[styles.progressBarBg, { backgroundColor: isDark ? '#1F222A' : '#F0F0F0' }]}>
                <LinearGradient
                    colors={['#FF4D67', '#FF8A9B']}
                    start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                    style={[styles.progressBarFill, { width: `${levelInfo.percentage}%` }]}
                />
            </View>
        )}
      </View>

      {/* Badges Reveal Modal */}
      <Modal visible={claimModalVisible} transparent animationType="fade">
        <View style={styles.modalOverlay}>
            <Animated.View style={[styles.badgeRevealCard, { backgroundColor }, animatedBadgeStyle]}>
                <Text style={styles.congratsText}>CONGRATULATIONS!</Text>
                <Text style={[styles.reachText, { color: textColor }]}>You reached Level {levelInfo.level}</Text>
                
                <View style={[styles.badgeCircle, { backgroundColor: isDark ? '#2D2D2D' : '#FFF5E6' }]}>
                    <Text style={styles.largeBadgeIcon}>🏆</Text>
                </View>

                <Text style={[styles.badgeNameText, { color: textColor }]}>Level {levelInfo.level} Badge</Text>
                <Text style={[styles.badgeDescText, { color: isDark ? '#BDBDBD' : '#666' }]}>This badge will now be shown on your profile ring.</Text>

                <TouchableOpacity style={styles.confirmClaimBtn} onPress={confirmClaim} disabled={loading}>
                    {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.confirmClaimBtnText}>CLAIM & EQUIP</Text>}
                </TouchableOpacity>
            </Animated.View>
        </View>
      </Modal>

    </View>
  );
};

const styles = StyleSheet.create({
  container: { paddingBottom: 20 },
  topBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, height: 56 },
  topBarLeft: { width: 40 },
  topBarRight: { width: 40, alignItems: 'flex-end' },
  usernameText: { fontSize: 18, fontFamily: 'Urbanist-Bold' },
  avatarWrapper: { alignSelf: 'center', marginTop: 10, position: 'relative' },
  avatarBorder: { width: 110, height: 110, borderRadius: 55, borderWidth: 1, padding: 3, justifyContent: 'center', alignItems: 'center' },
  avatarImage: { width: 100, height: 100, borderRadius: 50 },
  levelBadge: { position: 'absolute', bottom: 0, alignSelf: 'center', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, borderWidth: 2, borderColor: '#FFF' },
  levelText: { fontSize: 10, fontFamily: 'Urbanist-Bold', color: '#FFF' },
  equippedBadgeIcon: { position: 'absolute', top: -5, left: -5, borderRadius: 15, width: 30, height: 30, justifyContent: 'center', alignItems: 'center', elevation: 3, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 2 },
  infoSection: { alignItems: 'center', marginTop: 15, paddingHorizontal: 20 },
  fullNameText: { fontSize: 22, fontFamily: 'Urbanist-Bold' },
  bioText: { fontSize: 14, textAlign: 'center', marginTop: 8, fontFamily: 'Urbanist-Regular' },
  
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

  xpContainer: { marginTop: 20, paddingHorizontal: 30, width: '100%' },
  xpHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  xpLabel: { fontSize: 12, fontFamily: 'Urbanist-Bold', color: '#FF4D67' },
  xpValue: { fontSize: 12 },
  progressBarBg: { height: 10, borderRadius: 5, overflow: 'hidden' },
  progressBarFill: { height: '100%', borderRadius: 5 },
  claimButton: { height: 40, borderRadius: 20, justifyContent: 'center', alignItems: 'center', elevation: 4, shadowColor: '#FFA500', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 4 },
  claimButtonText: { color: '#fff', fontFamily: 'Urbanist-Bold', fontSize: 14 },
  statsRow: { flexDirection: 'row', justifyContent: 'space-around', marginTop: 25 },
  statItem: { alignItems: 'center', flex: 1 },
  statValue: { fontSize: 20, fontFamily: 'Urbanist-Bold' },
  statLabel: { fontSize: 13, marginTop: 4, fontFamily: 'Urbanist-Medium' },
  
  // Reveal Modal
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.85)', justifyContent: 'center', alignItems: 'center' },
  badgeRevealCard: { width: width * 0.8, borderRadius: 30, padding: 30, alignItems: 'center' },
  congratsText: { fontSize: 14, fontFamily: 'Urbanist-Bold', color: '#FFA500', letterSpacing: 2 },
  reachText: { fontSize: 24, fontFamily: 'Urbanist-Bold', marginVertical: 10 },
  badgeCircle: { width: 120, height: 120, borderRadius: 60, justifyContent: 'center', alignItems: 'center', marginVertical: 20, borderWidth: 5, borderColor: '#FFD700' },
  largeBadgeIcon: { fontSize: 60 },
  badgeNameText: { fontSize: 20, fontFamily: 'Urbanist-Bold' },
  badgeDescText: { fontSize: 14, textAlign: 'center', marginTop: 10, lineHeight: 20 },
  confirmClaimBtn: { marginTop: 30, backgroundColor: '#FF4D67', width: '100%', height: 50, borderRadius: 25, justifyContent: 'center', alignItems: 'center' },
  confirmClaimBtnText: { color: '#fff', fontFamily: 'Urbanist-Bold', fontSize: 16 }
});

export default ProfileHeader;
