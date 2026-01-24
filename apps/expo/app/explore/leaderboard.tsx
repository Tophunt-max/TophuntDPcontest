import React, { useState, useEffect, useCallback } from 'react';
import { 
  View, 
  Text, 
  StyleSheet, 
  FlatList, 
  Image, 
  TouchableOpacity, 
  ActivityIndicator, 
  SafeAreaView, 
  Dimensions, 
  RefreshControl 
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
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
  const [refreshing, setRefreshing] = useState(false);

  const bgColor = useThemeColor({}, 'background');
  const textColor = useThemeColor({}, 'text');
  const cardBg = useThemeColor({}, 'card');

  useEffect(() => {
    fetchData();
  }, [activeTab]);

  const fetchData = async () => {
    if (!refreshing) setLoading(true);
    try {
      let data: UserProfile[] = [];
      if (activeTab === 'wins') data = await leaderboardService.getTopWinners();
      else if (activeTab === 'votes') data = await leaderboardService.getMostVoted();
      else data = await leaderboardService.getTopLevels();
      
      setUsers(data || []);
    } catch (error) {
      console.error("Leaderboard Error:", error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchData();
  }, [activeTab]);

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
    if (users.length < 1) return null;
    const top3 = users.slice(0, 3);
    const first = top3[0];
    const second = top3[1];
    const third = top3[2];

    return (
      <View style={styles.podiumContainer}>
        {/* Second Place */}
        {second && (
          <View style={[styles.podiumItem, { marginTop: 40 }]}>
              <View style={styles.podiumAvatarWrapper}>
                <Image 
                    source={{ uri: second.profileImageUrl || `https://ui-avatars.com/api/?name=${second.fullName}&background=random` }} 
                    style={[styles.podiumAvatar, { borderColor: '#C0C0C0' }]} 
                />
                <LinearGradient colors={['#E0E0E0', '#BDBDBD']} style={styles.badgeContainer}>
                    <Text style={styles.badgeText}>2</Text>
                </LinearGradient>
              </View>
              <Text style={[styles.podiumName, { color: textColor }]} numberOfLines={1}>{second.fullName || second.username}</Text>
              <Text style={styles.podiumScore}>{getScore(second)}</Text>
          </View>
        )}

        {/* First Place */}
        {first && (
          <View style={styles.podiumItem}>
              <View style={styles.podiumAvatarWrapper}>
                  <Ionicons name="crown" size={32} color="#FFD700" style={styles.crown} />
                  <Image 
                      source={{ uri: first.profileImageUrl || `https://ui-avatars.com/api/?name=${first.fullName}&background=random` }} 
                      style={[styles.podiumAvatar, { width: 90, height: 90, borderWidth: 3, borderColor: '#FFD700' }]} 
                  />
                  <LinearGradient colors={['#FFD700', '#FFA000']} style={[styles.badgeContainer, { bottom: -5 }]}>
                    <Text style={styles.badgeText}>1</Text>
                  </LinearGradient>
              </View>
              <Text style={[styles.podiumName, { color: textColor, fontWeight: 'bold', fontSize: 16 }]} numberOfLines={1}>{first.fullName || first.username}</Text>
              <Text style={[styles.podiumScore, { color: '#FFD700', fontSize: 16 }]}>{getScore(first)}</Text>
          </View>
        )}

        {/* Third Place */}
        {third && (
          <View style={[styles.podiumItem, { marginTop: 60 }]}>
              <View style={styles.podiumAvatarWrapper}>
                <Image 
                    source={{ uri: third.profileImageUrl || `https://ui-avatars.com/api/?name=${third.fullName}&background=random` }} 
                    style={[styles.podiumAvatar, { borderColor: '#CD7F32' }]} 
                />
                <LinearGradient colors={['#D7CCC8', '#A1887F']} style={styles.badgeContainer}>
                    <Text style={styles.badgeText}>3</Text>
                </LinearGradient>
              </View>
              <Text style={[styles.podiumName, { color: textColor }]} numberOfLines={1}>{third.fullName || third.username}</Text>
              <Text style={styles.podiumScore}>{getScore(third)}</Text>
          </View>
        )}
      </View>
    );
  };

  const renderUserItem = ({ item, index }: { item: UserProfile; index: number }) => {
    if (index < 3) return null;

    return (
      <TouchableOpacity 
        style={[styles.userCard, { borderBottomColor: isDark ? '#2C2C2C' : '#F5F5F5' }]} 
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
          <Text style={[styles.userName, { color: textColor }]}>{item.fullName || 'Anonymous'}</Text>
          <View style={styles.handleRow}>
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

  const isDark = useThemeColor({}, 'background') === '#000000';

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: bgColor }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.iconButton}>
          <Ionicons name="chevron-back" size={28} color={textColor} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: textColor }]}>Top Hunters</Text>
        <TouchableOpacity style={styles.iconButton}>
          <Ionicons name="search-outline" size={24} color={textColor} />
        </TouchableOpacity>
      </View>

      <View style={[styles.tabContainer, { backgroundColor: isDark ? '#1F1F1F' : '#F5F5F5' }]}>
        {['wins', 'votes', 'xp'].map((tab) => (
            <TouchableOpacity 
                key={tab}
                style={[styles.tab, activeTab === tab && styles.activeTab, activeTab === tab && isDark && { backgroundColor: '#333' }]} 
                onPress={() => setActiveTab(tab as any)}
            >
            <Text style={[styles.tabText, activeTab === tab && styles.activeTabText]}>
                {tab === 'wins' ? 'Winners' : tab === 'votes' ? 'Popular' : 'Rank'}
            </Text>
            </TouchableOpacity>
        ))}
      </View>

      {loading && !refreshing ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#FF4D67" />
          <Text style={[styles.loadingText, { color: textColor }]}>Calculating Rankings...</Text>
        </View>
      ) : (
        <FlatList
          data={users}
          keyExtractor={(item) => item.uid}
          renderItem={renderUserItem}
          ListHeaderComponent={renderPodium}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#FF4D67" />
          }
          ListEmptyComponent={
            <View style={styles.center}>
                <Ionicons name="trophy-outline" size={60} color="#E0E0E0" />
                <Text style={styles.emptyText}>Be the first to join the leaderboard!</Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12 },
  title: { fontSize: 22, fontFamily: 'Urbanist-Bold' },
  iconButton: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  
  tabContainer: { flexDirection: 'row', marginHorizontal: 20, marginBottom: 15, borderRadius: 16, padding: 4 },
  tab: { flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: 14 },
  activeTab: { backgroundColor: 'white', elevation: 3, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.1, shadowRadius: 4 },
  tabText: { fontFamily: 'Urbanist-SemiBold', color: '#9E9E9E', fontSize: 14 },
  activeTabText: { color: '#FF4D67', fontFamily: 'Urbanist-Bold' },

  // Podium
  podiumContainer: { flexDirection: 'row', justifyContent: 'center', alignItems: 'flex-end', marginBottom: 30, marginTop: 20, height: 220, paddingHorizontal: 10 },
  podiumItem: { alignItems: 'center', width: width / 3.3 },
  podiumAvatarWrapper: { position: 'relative', alignItems: 'center', justifyContent: 'center' },
  podiumAvatar: { width: 75, height: 75, borderRadius: 40, marginBottom: 12, borderWidth: 3 },
  badgeContainer: { position: 'absolute', bottom: 5, width: 24, height: 24, borderRadius: 12, justifyContent: 'center', alignItems: 'center', borderWidth: 2, borderColor: '#FFF', zIndex: 10 },
  badgeText: { color: '#FFF', fontSize: 12, fontFamily: 'Urbanist-Bold' },
  crown: { position: 'absolute', top: -30, zIndex: 20 },
  podiumName: { fontSize: 13, fontFamily: 'Urbanist-Bold', marginBottom: 2, textAlign: 'center', width: '90%' },
  podiumScore: { fontFamily: 'Urbanist-Bold', color: '#FF4D67', fontSize: 15 },

  // List Item
  listContent: { paddingBottom: 40 },
  userCard: { flexDirection: 'row', alignItems: 'center', paddingVertical: 16, paddingHorizontal: 20, borderBottomWidth: 1 },
  rankContainer: { width: 35, alignItems: 'center', marginRight: 5 },
  rankText: { fontSize: 15, fontFamily: 'Urbanist-Bold', opacity: 0.6 },
  avatar: { width: 48, height: 48, borderRadius: 24, marginRight: 15 },
  userInfo: { flex: 1 },
  userName: { fontSize: 16, fontFamily: 'Urbanist-Bold' },
  handleRow: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
  userHandle: { fontSize: 12, color: '#9E9E9E' },
  levelTag: { backgroundColor: '#FFF9C4', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, marginRight: 8 },
  levelTagText: { fontSize: 10, color: '#FBC02D', fontFamily: 'Urbanist-Bold' },
  scoreContainer: { alignItems: 'flex-end' },
  scoreValue: { fontSize: 17, fontFamily: 'Urbanist-Bold', color: '#FF4D67' },
  scoreLabel: { fontSize: 9, color: '#9E9E9E', textTransform: 'uppercase', marginTop: 2 },
  
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', marginTop: 100 },
  loadingText: { marginTop: 15, fontFamily: 'Urbanist-Medium', opacity: 0.7 },
  emptyText: { textAlign: 'center', marginTop: 20, color: '#9E9E9E', fontFamily: 'Urbanist-Medium', width: '70%' }
});
