import React from 'react';
import { View, Text, Image, TouchableOpacity, StyleSheet } from 'react-native';
import { PrimaryButton } from '../buttons/PrimaryButton'; // Assuming we can reuse generic button or create specific small one

interface User {
  id: string;
  fullName: string;
  occupation: string;
  avatarUrl: string;
}

interface FollowUserCardProps {
  user: User;
  isFollowing: boolean;
  onToggleFollow: (userId: string) => void;
}

export const FollowUserCard: React.FC<FollowUserCardProps> = ({ user, isFollowing, onToggleFollow }) => {
  return (
    <View style={styles.container}>
      <Image source={{ uri: user.avatarUrl }} style={styles.avatar} />
      <View style={styles.info}>
        <Text style={styles.name}>{user.fullName}</Text>
        <Text style={styles.occupation}>{user.occupation}</Text>
      </View>
      <TouchableOpacity
        style={[styles.button, isFollowing ? styles.followingBtn : styles.followBtn]}
        onPress={() => onToggleFollow(user.id)}
      >
        <Text style={[styles.btnText, isFollowing ? styles.followingText : styles.followText]}>
          {isFollowing ? 'Following' : 'Follow'}
        </Text>
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 20,
    backgroundColor: 'transparent',
  },
  avatar: {
    width: 60,
    height: 60,
    borderRadius: 30,
  },
  info: {
    flex: 1,
    marginLeft: 16,
  },
  name: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#212121',
  },
  occupation: {
    fontSize: 14,
    color: '#9E9E9E',
  },
  button: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    minWidth: 90,
    alignItems: 'center',
    justifyContent: 'center',
  },
  followBtn: {
    backgroundColor: '#FF4D67',
  },
  followingBtn: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: '#FF4D67',
  },
  btnText: {
    fontSize: 14,
    fontWeight: '600',
  },
  followText: {
    color: '#fff',
  },
  followingText: {
    color: '#FF4D67',
  },
});
