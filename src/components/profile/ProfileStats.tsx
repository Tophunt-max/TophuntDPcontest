import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

interface UserStats {
  postsCount: number;
  followersCount: number;
  followingCount: number;
}

interface ProfileStatsProps {
  stats: UserStats;
}

const ProfileStats: React.FC<ProfileStatsProps> = ({ stats }) => {
  return (
    <View style={styles.statsContainer}>
      <View style={styles.statItem}>
          <Text style={styles.statNumber}>{stats.postsCount}</Text>
          <Text style={styles.statLabel}>Posts</Text>
      </View>
      <View style={styles.statItem}>
          <Text style={styles.statNumber}>{stats.followersCount}</Text>
          <Text style={styles.statLabel}>Followers</Text>
      </View>
      <View style={styles.statItem}>
          <Text style={styles.statNumber}>{stats.followingCount}</Text>
          <Text style={styles.statLabel}>Following</Text>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  statsContainer: {
      flex: 1,
      flexDirection: 'row',
      justifyContent: 'space-around',
      marginLeft: 20,
  },
  statItem: {
      alignItems: 'center',
  },
  statNumber: {
      fontSize: 18,
      fontWeight: '700',
      color: '#000',
  },
  statLabel: {
      fontSize: 13,
      color: '#666',
  },
});

export default ProfileStats;
