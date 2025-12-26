import React from 'react';
import { View, Text, StyleSheet, Image, TouchableOpacity } from 'react-native';
import { UserProfile } from '@/src/types/user';
import { Colors } from '@/constants/theme';
import { User_Plus, Settings_Icon, Pencil_Icon, Menu_Dark } from '@/assets/svgs';
import { useRouter } from 'expo-router';

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

  const formatFollowersCount = (count: number = 0): string => {
    if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
    if (count >= 1000) return `${(count / 1000).toFixed(1)}K`;
    return count.toString();
  };

  const handleSettingsPress = () => {
    router.push('/setting');
  };

  const handleEditProfilePress = () => {
    // Navigate to the newly created Manage Account screen
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

      {/* Profile Picture */}
      <View style={styles.avatarWrapper}>
        <View style={styles.avatarBorder}>
          <Image
            key={avatarUri} 
            source={profileImage}
            style={styles.avatarImage}
            resizeMode="cover"
          />
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
  },
  iconButton: {
    padding: 4,
  },
  avatarWrapper: {
    alignSelf: 'center',
    marginTop: 10,
    position: 'relative',
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
    zIndex: 1,
  },
  infoSection: {
    alignItems: 'center',
    marginTop: 15,
    paddingHorizontal: 20,
  },
  fullNameText: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1a1a1a',
  },
  emailText: {
    fontSize: 14,
    color: '#666',
    marginTop: 2,
  },
  bioText: {
    fontSize: 14,
    color: '#333',
    textAlign: 'center',
    marginTop: 8,
    lineHeight: 20,
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
    fontSize: 18,
    fontWeight: '700',
    color: '#000',
  },
  statLabel: {
    fontSize: 13,
    color: '#666',
    marginTop: 4,
  },
  actionRow: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    marginTop: 20,
    gap: 12,
  },
  mainButton: {
    flex: 1,
    height: 42,
    borderRadius: 8,
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
