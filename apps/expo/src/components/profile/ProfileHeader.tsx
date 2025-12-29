import React from 'react';
import { View, Text, StyleSheet, Image, TouchableOpacity, Dimensions, ScrollView } from 'react-native';
import { UserProfile } from '@/src/types/user';
import { Colors } from '@/constants/theme';
import { User_Plus, Settings_Icon, Pencil_Icon, Menu_Dark } from '@/assets/svgs';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';

type ProfileHeaderProps = {
  user: UserProfile;
  isOwnProfile: boolean;
  onToggleFollow: () => void;
  isFollowing?: boolean; 
};

const ProfileHeader: React.FC<ProfileHeaderProps> = ({ user, isOwnProfile, onToggleFollow, isFollowing }) => {
  const router = useRouter();
  
  const avatarUri = user.profileImageUrl || (user as any).avatarUrl;
  const defaultImage = require('@/assets/images/userLight.png');
  const profileImage = avatarUri ? { uri: avatarUri } : defaultImage;

  // Gamification Logic (Real Data)
  const xp = user.xp || 0;
  const level = user.level || Math.floor(xp / 1000) + 1;
  const progress = (xp % 1000) / 1000;
  const nextLevelXp = (Math.floor(xp / 1000) + 1) * 1000;

  // Badges (Real Data or Default)
  // If user has badges array, map them. Otherwise show placeholder/empty.
  // For now, we will keep the static badges list but eventually this should come from user.badges
  // Let's filter badges if user.badges exists, or show nothing if empty to be realistic
  
  const allBadges = [
      { id: 'winner', icon: '🏆', name: 'Winner', color: '#FFD700' },
      { id: 'hot', icon: '🔥', name: 'Hot', color: '#FF4500' },
      { id: 'pro', icon: '📸', name: 'Pro', color: '#1E90FF' },
      { id: 'star', icon: '⭐', name: 'Star', color: '#9370DB' },
      { id: 'voter', icon: '🗳️', name: 'Voter', color: '#4CAF50' },
  ];

  // If user has badges (array of strings like ['winner', 'hot']), filter them
  // If not, show empty list (no fake badges)
  const userBadges = user.badges 
      ? allBadges.filter(b => user.badges?.includes(b.id)) 
      : []; 
  
  // Fallback for visual testing if you want to see something:
  // const displayBadges = userBadges.length > 0 ? userBadges : [{ id: 'new', icon: '🌱', name: 'Newbie', color: '#888' }];
  const displayBadges = userBadges;

  const formatFollowersCount = (count: number = 0): string => {
    if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
    if (count >= 1000) return `${(count / 1000).toFixed(1)}K`;
    return count.toString();
  };

  const handleSettingsPress = () => {
    router.push('/setting');
  };

  const handleEditProfilePress = () => {
    router.push('/profile/manage');
  };

  return (
    <View style={styles.container}>
      {/* Top Bar */}
      <View style={styles.topBar}>
        <View style={styles.topBarLeft}>
           {!isOwnProfile && (
             <TouchableOpacity style={styles.iconButton}>
               <User_Plus width={24} height={24} />
             </TouchableOpacity>
           )}
        </View>
        
        <Text style={styles.usernameText}>{user.username || 'username'}</Text>

        <View style={styles.topBarRight}>
           {isOwnProfile && (
             <TouchableOpacity style={styles.iconButton} onPress={handleSettingsPress}>
               <Settings_Icon width={24} height={24} />
             </TouchableOpacity>
           )}
        </View>
      </View>

      {/* Profile Picture with Level Ring */}
      <View style={styles.avatarWrapper}>
        <View style={styles.avatarBorder}>
          <Image
            key={avatarUri} 
            source={profileImage}
            style={styles.avatarImage}
            resizeMode="cover"
          />
        </View>
        <View style={styles.levelBadge}>
            <Text style={styles.levelText}>Lv. {level}</Text>
        </View>
        
        {isOwnProfile && (
          <TouchableOpacity 
            style={styles.editBadge} 
            onPress={handleEditProfilePress}
            activeOpacity={0.7}
          >
            <Pencil_Icon width={14} height={14} fill="white" />
          </TouchableOpacity>
        )}
      </View>

      {/* User Info */}
      <View style={styles.infoSection}>
        <Text style={styles.fullNameText}>{user.fullName || 'User Name'}</Text>
        <Text style={styles.emailText}>{user.email}</Text>
        {user.bio ? <Text style={styles.bioText}>{user.bio}</Text> : null}
      </View>

      {/* XP Progress Bar */}
      <View style={styles.xpContainer}>
        <View style={styles.xpHeader}>
            <Text style={styles.xpLabel}>Level {level}</Text>
            <Text style={styles.xpValue}>{xp} / {nextLevelXp} XP</Text>
        </View>
        <View style={styles.progressBarBg}>
            <LinearGradient
                colors={['#FF4D67', '#FF8A9B']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={[styles.progressBarFill, { width: `${Math.min(progress * 100, 100)}%` }]}
            />
        </View>
      </View>

      {/* Badges Section */}
      {displayBadges.length > 0 && (
        <View style={styles.badgesContainer}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 20 }}>
                {displayBadges.map((badge) => (
                    <View key={badge.id} style={[styles.badgeItem, { backgroundColor: badge.color + '20' }]}>
                        <Text style={styles.badgeIcon}>{badge.icon}</Text>
                        <Text style={[styles.badgeName, { color: badge.color }]}>{badge.name}</Text>
                    </View>
                ))}
            </ScrollView>
        </View>
      )}

      {/* Stats Section */}
      <View style={styles.statsRow}>
        <View style={styles.statItem}>
          <Text style={styles.statValue}>{(user as any).postsCount || 0}</Text>
          <Text style={styles.statLabel}>Post</Text>
        </View>
        <View style={styles.statItem}>
          <Text style={styles.statValue}>{formatFollowersCount((user as any).followersCount || 0)}</Text>
          <Text style={styles.statLabel}>Followers</Text>
        </View>
        <View style={styles.statItem}>
          <Text style={styles.statValue}>{(user as any).followingCount || 0}</Text>
          <Text style={styles.statLabel}>Following</Text>
        </View>
      </View>

      {/* Action Buttons */}
      {!isOwnProfile && (
        <View style={styles.actionRow}>
          <TouchableOpacity 
            style={[styles.mainButton, isFollowing ? styles.secondaryButton : styles.primaryButton]}
            onPress={onToggleFollow}
          >
            <Text style={[styles.buttonText, isFollowing ? styles.textBlack : styles.textWhite]}>
              {isFollowing ? 'Following' : 'Follow'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.mainButton, styles.secondaryButton]}>
            <Text style={[styles.buttonText, styles.textBlack]}>Message</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#fff',
    paddingBottom: 20,
  },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    height: 56,
  },
  topBarLeft: { width: 40 },
  topBarRight: { width: 40, alignItems: 'flex-end' },
  usernameText: {
    fontSize: 18,
    fontWeight: '700',
    color: '#000',
    fontFamily: 'Urbanist-Bold',
  },
  iconButton: {
    padding: 4,
  },
  avatarWrapper: {
    alignSelf: 'center',
    marginTop: 10,
    position: 'relative',
    marginBottom: 10,
  },
  avatarBorder: {
    width: 110,
    height: 110,
    borderRadius: 55,
    borderWidth: 1,
    borderColor: '#eee',
    padding: 3,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#fff',
  },
  avatarImage: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: '#f8f8f8',
  },
  editBadge: {
    position: 'absolute',
    bottom: 5,
    right: 5,
    backgroundColor: '#ff4466',
    width: 28,
    height: 28,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#fff',
    zIndex: 2,
  },
  levelBadge: {
      position: 'absolute',
      top: 0,
      right: 0,
      backgroundColor: '#FFD700',
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: 10,
      borderWidth: 2,
      borderColor: '#FFF',
      zIndex: 2,
  },
  levelText: {
      fontSize: 10,
      fontWeight: 'bold',
      color: '#856404',
  },
  infoSection: {
    alignItems: 'center',
    marginTop: 5,
    paddingHorizontal: 20,
  },
  fullNameText: {
    fontSize: 22,
    fontWeight: '700',
    color: '#1a1a1a',
    fontFamily: 'Urbanist-Bold',
  },
  emailText: {
    fontSize: 14,
    color: '#999',
    marginTop: 2,
    fontFamily: 'Urbanist-Medium',
  },
  bioText: {
    fontSize: 14,
    color: '#333',
    textAlign: 'center',
    marginTop: 8,
    lineHeight: 20,
    fontFamily: 'Urbanist-Regular',
  },
  
  // XP Styles
  xpContainer: {
      marginTop: 20,
      paddingHorizontal: 30,
      width: '100%',
  },
  xpHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginBottom: 6,
  },
  xpLabel: {
      fontSize: 12,
      fontWeight: 'bold',
      color: '#FF4D67',
  },
  xpValue: {
      fontSize: 12,
      color: '#888',
  },
  progressBarBg: {
      height: 8,
      backgroundColor: '#F0F0F0',
      borderRadius: 4,
      overflow: 'hidden',
  },
  progressBarFill: {
      height: '100%',
      borderRadius: 4,
  },

  // Badges Styles
  badgesContainer: {
      marginTop: 20,
      height: 40,
  },
  badgeItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: 20,
      marginRight: 10,
  },
  badgeIcon: {
      fontSize: 14,
      marginRight: 5,
  },
  badgeName: {
      fontSize: 12,
      fontWeight: 'bold',
  },

  statsRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginTop: 25,
    paddingHorizontal: 10,
  },
  statItem: {
    alignItems: 'center',
    flex: 1,
  },
  statValue: {
    fontSize: 20,
    fontWeight: '700',
    color: '#000',
    fontFamily: 'Urbanist-Bold',
  },
  statLabel: {
    fontSize: 13,
    color: '#666',
    marginTop: 4,
    fontFamily: 'Urbanist-Medium',
  },
  actionRow: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    marginTop: 20,
    gap: 12,
  },
  mainButton: {
    flex: 1,
    height: 44,
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
  },
  primaryButton: {
    backgroundColor: '#ff4466',
  },
  secondaryButton: {
    backgroundColor: '#f0f0f0',
  },
  buttonText: {
    fontSize: 15,
    fontWeight: '600',
  },
  textWhite: { color: '#fff' },
  textBlack: { color: '#000' },
});

export default ProfileHeader;
