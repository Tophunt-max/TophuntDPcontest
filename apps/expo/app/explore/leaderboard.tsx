import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, FlatList, Image, TouchableOpacity, ActivityIndicator, SafeAreaView, Dimensions } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { leaderboardService } from '@/src/services/contests/leaderboardService';
import { UserProfile } from '@/src/types/user';
import { useThemeColor } from '@/hooks/use-theme-color';
import { LinearGradient } from 'expo-linear-gradient';

const { width } = Dimensions.get('window');

export default function LeaderboardScreen() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<'wins' | 'votes' | 'xp'>('wins');
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
      let data: UserProfile[] = [];
      if (activeTab === 'wins') data = await leaderboardService.getTopWinners();
      else if (activeTab === 'votes') data = await leaderboardService.getMostVoted();
      else data = await leaderboardService.getTopLevels();
      
      setUsers(data);
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  const getScore = (user: UserProfile) => {
    if (activeTab === 'wins') return user.stats?.wins || 0;
    if (activeTab === 'votes') return user.stats?.totalVotesReceived || 0;
    return user.xp || 0;
  };

  const getLabel = () => {
    if (activeTab === 'wins') return 'Wins';
    if (activeTab === 'votes') return 'Votes';
    return 'XP';
  };

  const renderPodium = () => {
    if (users.length < 3) return null;
    const [first, second, third] = users;

    return (
      <View style={styles.podiumContainer}>
        {/* Second Place */}
        <View style={[styles.podiumItem, { marginTop: 40 }]}>
            <Image 
                source={{ uri: second.profileImageUrl || `https://ui-avatars.com/api/?name=${second.fullName}&background=random` }} 
                style={styles.podiumAvatar} 
            />
            <View style={styles.badgeContainer}><Text style={styles.badgeText}>2</Text></View>
            <Text style={[styles.podiumName, { color: textColor }]} numberOfLines={1}>{second.fullName}</Text>
            <Text style={styles.podiumScore}>{getScore(second)}</Text>
        </View>

        {/* First Place */}
        <View style={styles.podiumItem}>
            <View style={{ position: 'relative' }}>
                <MaterialCommunityIcons name="crown" size={32} color="#FFD700" style={styles.crown} />
                <Image 
                    source={{ uri: first.profileImageUrl || `https://ui-avatars.com/api/?name=${first.fullName}&background=random` }} 
                    style={[styles.podiumAvatar, { width: 90, height: 90, borderWidth: 3, borderColor: '#FFD700' }]} 
                />
                <View style={[styles.badgeContainer, { backgroundColor: '#FFD700' }]}><Text style={styles.badgeText}>1</Text></View>
            </View>
            <Text style={[styles.podiumName, { color: textColor, fontWeight: 'bold', fontSize: 16 }]} numberOfLines={1}>{first.fullName}</Text>
            <Text style={[styles.podiumScore, { color: '#FFD700', fontSize: 16 }]}>{getScore(first)}</Text>
        </View>

        {/* Third Place */}
        <View style={[styles.podiumItem, { marginTop: 60 }]}>
            <Image 
                source={{ uri: third.profileImageUrl || `https://ui-avatars.com/api/?name=${third.fullName}&background=random` }} 
                style={styles.podiumAvatar} 
            />
            <View style={[styles.badgeContainer, { backgroundColor: '#CD7F32' }]}><Text style={styles.badgeText}>3</Text></View>
            <Text style={[styles.podiumName, { color: textColor }]} numberOfLines={1}>{third.fullName}</Text>
            <Text style={styles.podiumScore}>{getScore(third)}</Text>
        </View>
      </View>
    );
  };

  const renderUserItem = ({ item, index }: { item: UserProfile; index: number }) => {
    // Skip top 3 as they are in podium
    if (index < 3) return null;

    return (
      <TouchableOpacity 
        style={styles.userCard} 
        onPress={() => router.push({ pathname: '/profile', params: { userId: item.uid } })}
      >
        <View style={styles.rankContainer}>
            <Text style={[styles.rankText, { color: textColor }]}>{index + 1}</Text>
        </View>

        <Image 
          source={{ uri: item.profileImageUrl || `https://ui-avatars.com/api/?name=${item.fullName}&background=random` }} 
          style={styles.avatar} 
        />

        <View style={styles.userInfo}>
          <Text style={[styles.userName, { color: textColor }]}>{item.fullName}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
            {item.level && <View style={styles.levelTag}><Text style={styles.levelTagText}>Lv. {item.level}</Text></View>}
            <Text style={styles.userHandle}>@{item.username}</Text>
          </View>
        </View>

        <View style={styles.scoreContainer}>
          <Text style={styles.scoreValue}>{getScore(item)}</Text>
          <Text style={styles.scoreLabel}>{getLabel()}</Text>
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
        {['wins', 'votes', 'xp'].map((tab) => (
            <TouchableOpacity 
                key={tab}
                style={[styles.tab, activeTab === tab && styles.activeTab]} 
                onPress={() => setActiveTab(tab as any)}
            >
            <Text style={[styles.tabText, activeTab === tab && styles.activeTabText]}>
                {tab === 'wins' ? 'Winners' : tab === 'votes' ? 'Voted' : 'Top XP'}
            </Text>
            </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <ActivityIndicator size="large" color="#FF4D67" style={{ marginTop: 50 }} />
      ) : (
        <FlatList
          data={users}
          keyExtractor={(item) => item.uid}
          renderItem={renderUserItem}
          ListHeaderComponent={renderPodium}
          contentContainerStyle={{ paddingBottom: 40 }}
          ListEmptyComponent={<Text style={styles.emptyText}>No rankings available yet.</Text>}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16 },
  title: { fontSize: 22, fontFamily: 'Urbanist-Bold' },
  
  tabContainer: { flexDirection: 'row', marginHorizontal: 16, marginBottom: 10, backgroundColor: '#F5F5F5', borderRadius: 12, padding: 4 },
  tab: { flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: 10 },
  activeTab: { backgroundColor: 'white', elevation: 2, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.1, shadowRadius: 2 },
  tabText: { fontFamily: 'Urbanist-SemiBold', color: '#9E9E9E', fontSize: 13 },
  activeTabText: { color: '#FF4D67' },

  // Podium
  podiumContainer: { flexDirection: 'row', justifyContent: 'center', alignItems: 'flex-end', marginBottom: 30, marginTop: 10, height: 200 },
  podiumItem: { alignItems: 'center', width: width / 3.5 },
  podiumAvatar: { width: 70, height: 70, borderRadius: 35, marginBottom: 8, borderWidth: 2, borderColor: '#C0C0C0' },
  badgeContainer: { position: 'absolute', bottom: 50, backgroundColor: '#C0C0C0', width: 20, height: 20, borderRadius: 10, justifyContent: 'center', alignItems: 'center', borderWidth: 2, borderColor: '#FFF' },
  badgeText: { color: '#FFF', fontSize: 10, fontWeight: 'bold' },
  crown: { position: 'absolute', top: -34, left: 29, transform: [{ rotate: '-10deg' }] },
  podiumName: { fontSize: 13, fontFamily: 'Urbanist-Bold', marginBottom: 2, textAlign: 'center' },
  podiumScore: { fontFamily: 'Urbanist-Bold', color: '#FF4D67', fontSize: 14 },

  // List Item
  userCard: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 20, borderBottomWidth: 1, borderBottomColor: '#F5F5F5' },
  rankContainer: { width: 30, alignItems: 'center', marginRight: 10 },
  rankText: { fontSize: 16, fontFamily: 'Urbanist-Bold', color: '#9E9E9E' },
  avatar: { width: 44, height: 44, borderRadius: 22, marginRight: 12 },
  userInfo: { flex: 1 },
  userName: { fontSize: 15, fontFamily: 'Urbanist-Bold' },
  userHandle: { fontSize: 12, color: '#9E9E9E' },
  levelTag: { backgroundColor: '#FFF8E1', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, marginRight: 6 },
  levelTagText: { fontSize: 10, color: '#FFD700', fontWeight: 'bold' },
  scoreContainer: { alignItems: 'flex-end' },
  scoreValue: { fontSize: 16, fontFamily: 'Urbanist-Bold', color: '#FF4D67' },
  scoreLabel: { fontSize: 10, color: '#9E9E9E', textTransform: 'uppercase' },
  emptyText: { textAlign: 'center', marginTop: 50, color: '#9E9E9E', fontFamily: 'Urbanist-Medium' }
});
