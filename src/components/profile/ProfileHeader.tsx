import React from 'react';
import { View, Text, StyleSheet, Image, TouchableOpacity } from 'react-native';
import { UserProfile } from '@/src/types/user';
import { Colors } from '@/constants/theme';
import { User_Plus, Settings_Icon, Pencil_Icon } from '@/assets/svgs';

type ProfileHeaderProps = {
  user: UserProfile;
  isOwnProfile: boolean;
  onToggleFollow: () => void;
  // This prop assumes you have logic to determine if the current user is following this profile
  isFollowing?: boolean; 
};

const ProfileHeader: React.FC<ProfileHeaderProps> = ({ user, isOwnProfile, onToggleFollow, isFollowing }) => {
  
  const formatFollowersCount = (count: number): string => {
    if (count >= 1000000) {
      return `${(count / 1000000).toFixed(1)}M`;
    }
    if (count >= 1000) {
      return `${(count / 1000).toFixed(1)}K`;
    }
    return count.toString();
  };

  return (
    <View style={styles.container}>
      {/* Top Bar */}
      <View style={styles.topBar}>
        <TouchableOpacity style={styles.topBarButton}>
          {!isOwnProfile && <User_Plus width={24} height={24} />}
        </TouchableOpacity>
        <Text style={styles.username}>{user.username}</Text>
        <TouchableOpacity style={styles.topBarButton}>
          {isOwnProfile && <Settings_Icon width={24} height={24} />}
        </TouchableOpacity>
      </View>

      {/* Avatar and Info */}
      <View style={styles.avatarContainer}>
        <Image
          source={{ uri: user.profileImageUrl || 'https://via.placeholder.com/150' }}
          style={styles.avatar}
        />
        {isOwnProfile && (
          <TouchableOpacity style={styles.editIcon}>
            <Pencil_Icon width={16} height={16} fill="white" />
          </TouchableOpacity>
        )}
      </View>

      <Text style={styles.fullName}>{user.fullName}</Text>
      <Text style={styles.email}>{user.email}</Text>
      <Text style={styles.bio}>{user.bio}</Text>

      {/* Stats */}
      <View style={styles.statsContainer}>
        <View style={styles.stat}>
          <Text style={styles.statNumber}>{user.postsCount || 0}</Text>
          <Text style={styles.statLabel}>Post</Text>
        </View>
        <View style={styles.stat}>
          <Text style={styles.statNumber}>{formatFollowersCount(user.followersCount || 0)}</Text>
          <Text style={styles.statLabel}>Followers</Text>
        </View>
        <View style={styles.stat}>
          <Text style={styles.statNumber}>{user.followingCount || 0}</Text>
          <Text style={styles.statLabel}>Following</Text>
        </View>
      </View>

      {/* Action Buttons */}
      {!isOwnProfile && (
        <View style={styles.buttonContainer}>
          <TouchableOpacity 
            style={[styles.button, isFollowing ? styles.messageButton : styles.followButton]}
            onPress={onToggleFollow}
          >
            <Text style={isFollowing ? styles.buttonTextBlack : styles.buttonTextWhite}>
              {isFollowing ? 'Following' : 'Follow'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.button, styles.messageButton]}>
            <Text style={styles.buttonTextBlack}>Message</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    padding: 16,
    backgroundColor: '#fff',
  },
  topBar: {
    width: '100%',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  topBarButton: {
    width: 40, // for alignment
  },
  username: {
    fontSize: 20,
    fontWeight: 'bold',
  },
  avatarContainer: {
    position: 'relative',
    marginBottom: 12,
  },
  avatar: {
    width: 100,
    height: 100,
    borderRadius: 50,
  },
  editIcon: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    backgroundColor: Colors.light.primary,
    borderRadius: 15,
    width: 30,
    height: 30,
    justifyContent: 'center',
    alignItems: 'center',
  },
  fullName: {
    fontSize: 18,
    fontWeight: '600',
  },
  email: {
    color: 'gray',
    marginBottom: 8,
  },
  bio: {
    textAlign: 'center',
    marginBottom: 16,
  },
  statsContainer: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    width: '100%',
    marginBottom: 16,
  },
  stat: {
    alignItems: 'center',
  },
  statNumber: {
    fontSize: 18,
    fontWeight: 'bold',
  },
  statLabel: {
    color: 'gray',
    fontSize: 12,
  },
  buttonContainer: {
    flexDirection: 'row',
    width: '100%',
  },
  button: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    marginHorizontal: 8,
    borderWidth: 1,
  },
  followButton: {
    backgroundColor: Colors.light.primary,
    borderColor: Colors.light.primary,
  },
  messageButton: {
    backgroundColor: '#f0f0f0',
    borderColor: '#ddd',
  },
  buttonTextWhite: {
    color: 'white',
    fontWeight: 'bold',
  },
  buttonTextBlack: {
    color: 'black',
    fontWeight: 'bold',
  },
});

export default ProfileHeader;
