import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, FlatList, Image, TouchableOpacity, ActivityIndicator, SafeAreaView } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { leaderboardService } from '@/src/services/contests/leaderboardService';
import { UserProfile } from '@/src/types/user';
import { useThemeColor } from '@/hooks/use-theme-color';

export default function LeaderboardScreen() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<'wins' | 'votes'>('wins');
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(true);

  const bgColor = useThemeColor({}, 'background');
  const textColor = useThemeColor({}, 'text');

  useEffect(() => {
    fetchData();
  }, [activeTab]);

  const fetchData = async () => {
    setLoading(true);
    try {
      const data = activeTab === 'wins' 
        ? await leaderboardService.getTopWinners() 
        : await leaderboardService.getMostVoted();
      setUsers(data);
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  const renderUserItem = ({ item, index }: { item: UserProfile; index: number }) => {
    const isTop3 = index < 3;
    const medalColors = ['#FFD700', '#C0C0C0', '#CD7F32'];

    return (
      <TouchableOpacity 
        style={styles.userCard} 
        onPress={() => router.push({ pathname: '/profile', params: { userId: item.uid } })}
      >
        <View style={styles.rankContainer}>
          {isTop3 ? (
            <Ionicons name="trophy" size={24} color={medalColors[index]} />
          ) : (
            <Text style={[styles.rankText, { color: textColor }]}>{index + 1}</Text>
          )}
        </View>

        <Image 
          source={{ uri: item.profileImageUrl || `https://ui-avatars.com/api/?name=${item.fullName}&background=random` }} 
          style={styles.avatar} 
        />

        <View style={styles.userInfo}>
          <Text style={[styles.userName, { color: textColor }]}>{item.fullName}</Text>
          <Text style={styles.userHandle}>@{item.username}</Text>
        </View>

        <View style={styles.scoreContainer}>
          <Text style={styles.scoreValue}>
            {activeTab === 'wins' ? item.stats?.wins : item.stats?.totalVotesReceived}
          </Text>
          <Text style={styles.scoreLabel}>{activeTab === 'wins' ? 'Wins' : 'Votes'}</Text>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: bgColor }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={28} color={textColor} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: textColor }]}>Leaderboard</Text>
        <View style={{ width: 28 }} />
      </View>

      <View style={styles.tabContainer}>
        <TouchableOpacity 
          style={[styles.tab, activeTab === 'wins' && styles.activeTab]} 
          onPress={() => setActiveTab('wins')}
        >
          <Text style={[styles.tabText, activeTab === 'wins' && styles.activeTabText]}>Top Winners</Text>
        </TouchableOpacity>
        <TouchableOpacity 
          style={[styles.tab, activeTab === 'votes' && styles.activeTab]} 
          onPress={() => setActiveTab('votes')}
        >
          <Text style={[styles.tabText, activeTab === 'votes' && styles.activeTabText]}>Most Voted</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <ActivityIndicator size="large" color="#FF4D67" style={{ marginTop: 50 }} />
      ) : (
        <FlatList
          data={users}
          keyExtractor={(item) => item.uid}
          renderItem={renderUserItem}
          contentContainerStyle={{ padding: 16 }}
          ListEmptyComponent={<Text style={styles.emptyText}>No rankings yet.</Text>}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16 },
  title: { fontSize: 22, fontFamily: 'Urbanist-Bold' },
  tabContainer: { flexDirection: 'row', marginHorizontal: 16, marginBottom: 20, backgroundColor: '#F5F5F5', borderRadius: 12, padding: 4 },
  tab: { flex: 1, paddingVertical: 12, alignItems: 'center', borderRadius: 10 },
  activeTab: { backgroundColor: 'white', elevation: 2, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.1, shadowRadius: 2 },
  tabText: { fontFamily: 'Urbanist-SemiBold', color: '#9E9E9E' },
  activeTabText: { color: '#FF4D67' },
  userCard: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#EEE' },
  rankContainer: { width: 40, alignItems: 'center' },
  rankText: { fontSize: 16, fontFamily: 'Urbanist-Bold' },
  avatar: { width: 50, height: 50, borderRadius: 25, marginLeft: 10 },
  userInfo: { flex: 1, marginLeft: 15 },
  userName: { fontSize: 16, fontFamily: 'Urbanist-Bold' },
  userHandle: { fontSize: 12, color: '#9E9E9E', marginTop: 2 },
  scoreContainer: { alignItems: 'flex-end' },
  scoreValue: { fontSize: 18, fontFamily: 'Urbanist-Bold', color: '#FF4D67' },
  scoreLabel: { fontSize: 10, color: '#9E9E9E', textTransform: 'uppercase' },
  emptyText: { textAlign: 'center', marginTop: 50, color: '#9E9E9E', fontFamily: 'Urbanist-Medium' }
});
