import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, SafeAreaView, useColorScheme, FlatList, Image, TouchableOpacity, TextInput, ScrollView, ActivityIndicator } from 'react-native';
import { BottomNav } from '@/src/components/home/BottomNav';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { contestService } from '@/src/services/contests/contestService';
import { Contest, Battle } from '@/src/types/contest';

export default function DiscoverScreen() {
  const router = useRouter();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const backgroundColor = isDark ? '#181A20' : '#fff';
  const textColor = isDark ? '#fff' : '#000';
  
  const [loading, setLoading] = useState(true);
  const [liveContests, setLiveContests] = useState<Contest[]>([]);
  const [trendingBattles, setTrendingBattles] = useState<Battle[]>([]);

  useEffect(() => {
    fetchExploreData();
  }, []);

  const fetchExploreData = async () => {
    setLoading(true);
    try {
      const [contests, battles] = await Promise.all([
        contestService.getLiveContests(),
        contestService.getActiveBattles(undefined, 10)
      ]);
      setLiveContests(contests);
      setTrendingBattles(battles);
    } catch (error) {
      console.error("Explore error:", error);
    } finally {
      setLoading(false);
    }
  };

  const renderContestItem = ({ item }: { item: Contest }) => (
    <TouchableOpacity style={styles.contestTag}>
      <Text style={styles.contestTagName}>#{item.name.replace(/\s+/g, '')}</Text>
    </TouchableOpacity>
  );

  const renderBattleGridItem = ({ item }: { item: Battle }) => (
    <TouchableOpacity style={styles.gridItem}>
      <View style={styles.gridMediaContainer}>
        <Image source={{ uri: item.userA.mediaUrl }} style={styles.gridMedia} />
        <View style={styles.vsSmallBadge}><Text style={styles.vsSmallText}>VS</Text></View>
        <Image source={{ uri: item.userB.mediaUrl }} style={styles.gridMedia} />
      </View>
      <View style={styles.gridInfo}>
        <Text style={[styles.gridTitle, {color: textColor}]} numberOfLines={1}>{item.contestName}</Text>
        <Text style={styles.gridVotes}>{item.totalVotes} votes</Text>
      </View>
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]}>
      <View style={styles.header}>
        <View style={styles.topRow}>
          <Text style={[styles.headerTitle, { color: textColor }]}>Explore</Text>
          <TouchableOpacity 
            style={styles.leaderboardBtn} 
            onPress={() => router.push('/explore/leaderboard')}
          >
            <Ionicons name="trophy-outline" size={26} color="#FF4D67" />
            <Text style={styles.leaderboardBtnText}>Ranking</Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity style={[styles.searchBar, { backgroundColor: isDark ? '#1F222A' : '#F5F5F5' }]}>
          <Ionicons name="search" size={20} color="#9E9E9E" />
          <Text style={styles.searchPlaceholder}>Search contests, users...</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <ActivityIndicator size="large" color="#FF4D67" style={{marginTop: 50}} />
      ) : (
        <ScrollView showsVerticalScrollIndicator={false}>
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: textColor }]}>Live Contests</Text>
            <FlatList
              horizontal
              data={liveContests}
              renderItem={renderContestItem}
              keyExtractor={(item) => item.id}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingLeft: 16 }}
            />
          </View>

          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={[styles.sectionTitle, { color: textColor }]}>Trending Battles</Text>
              <TouchableOpacity><Text style={{color: '#FF4D67', fontFamily: 'Urbanist-Bold'}}>See All</Text></TouchableOpacity>
            </View>
            <FlatList
              data={trendingBattles}
              numColumns={2}
              renderItem={renderBattleGridItem}
              keyExtractor={(item) => item.id}
              scrollEnabled={false}
              contentContainerStyle={{ paddingHorizontal: 12 }}
            />
          </View>
        </ScrollView>
      )}

      <BottomNav backgroundColor={backgroundColor} isDark={isDark} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { padding: 16 },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15 },
  headerTitle: { fontSize: 28, fontFamily: 'Urbanist-Bold' },
  leaderboardBtn: { alignItems: 'center' },
  leaderboardBtnText: { fontSize: 10, color: '#FF4D67', fontFamily: 'Urbanist-Bold', marginTop: 2 },
  searchBar: { flexDirection: 'row', alignItems: 'center', padding: 12, borderRadius: 12 },
  searchPlaceholder: { color: '#9E9E9E', marginLeft: 10, fontFamily: 'Urbanist-Medium' },
  section: { marginTop: 25 },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, marginBottom: 15 },
  sectionTitle: { fontSize: 18, fontFamily: 'Urbanist-Bold', paddingHorizontal: 16, marginBottom: 15 },
  contestTag: { backgroundColor: '#FF4D6715', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20, marginRight: 10, borderWidth: 1, borderColor: '#FF4D6740' },
  contestTagName: { color: '#FF4D67', fontFamily: 'Urbanist-Bold' },
  gridItem: { flex: 1, margin: 4, borderRadius: 16, overflow: 'hidden' },
  gridMediaContainer: { flexDirection: 'row', height: 150, backgroundColor: '#EEE' },
  gridMedia: { flex: 1, height: '100%' },
  vsSmallBadge: { position: 'absolute', top: '40%', left: '40%', zIndex: 5, backgroundColor: 'black', borderRadius: 10, paddingHorizontal: 4, paddingVertical: 2, borderWidth: 1, borderColor: 'white' },
  vsSmallText: { color: 'white', fontSize: 10, fontFamily: 'Urbanist-Bold' },
  gridInfo: { padding: 8 },
  gridTitle: { fontSize: 13, fontFamily: 'Urbanist-Bold' },
  gridVotes: { fontSize: 11, color: '#9E9E9E', marginTop: 2 }
});
