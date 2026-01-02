import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, SafeAreaView, useColorScheme, FlatList, Image, TouchableOpacity, ScrollView, ActivityIndicator, Dimensions, Platform } from 'react-native';
import { BottomNav } from '@/src/components/home/BottomNav';
import { Ionicons, FontAwesome5, MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter, usePathname } from 'expo-router';
import { contestService } from '@/src/services/contests/contestService';
import { useAuth } from '@/src/hooks/useAuth';
import { LinearGradient } from 'expo-linear-gradient';

const { width } = Dimensions.get('window');

export default function DiscoverScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const { user, loading: authLoading } = useAuth();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  
  // Theme Colors
  const backgroundColor = isDark ? '#000000' : '#F2F2F7'; 
  const cardBg = isDark ? '#1C1C1E' : '#FFFFFF';
  const textColor = isDark ? '#FFFFFF' : '#000000';
  const subTextColor = isDark ? '#AEAEB2' : '#8E8E93';
  const primaryColor = '#FF3B30'; 
  const accentColor = '#007AFF'; 
  
  const [loading, setLoading] = useState(true);
  const [availableContests, setAvailableContests] = useState<any[]>([]);
  const [waitingMatches, setWaitingMatches] = useState<any[]>([]);

  useEffect(() => {
    // Fetch data regardless of auth state (public view)
    if (!authLoading) {
        fetchExploreData();
    }
  }, [authLoading, user]);

  const fetchExploreData = async () => {
    setLoading(true);
    try {
      const [contests, waiting] = await Promise.all([
        contestService.getAvailableContests(),
        // Pass user?.uid if available, otherwise undefined for public view
        contestService.getWaitingMatches(undefined, user?.uid)
      ]);
      setAvailableContests(contests);
      setWaitingMatches(waiting);
    } catch (error) {
      console.error("Explore error:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleAction = (action: () => void) => {
      if (!user) {
          // Unauthenticated -> Redirect to Login with callback
          const redirect = encodeURIComponent('/explore'); // Or current path
          router.push(`/auth/login?redirect=${redirect}`);
      } else {
          // Authenticated -> Proceed
          action();
      }
  };

  const renderContestTag = ({ item }: { item: any }) => {
    if (!item || !item.title) return null;
    return (
      <TouchableOpacity 
        style={styles.categoryCard}
        onPress={() => handleAction(() => {
            router.push({ 
                pathname: item.type === 'video' ? '/contest/video' : '/contest/photo', 
                params: { contestId: item.id } 
            });
        })}
      >
        <LinearGradient
          colors={['#FF4D67', '#FF8E53']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.categoryGradient}
        >
          <Ionicons name={item.type === 'video' ? 'videocam' : 'camera'} size={24} color="#FFF" />
          <Text style={styles.categoryText}>#{item.title.replace(/\s+/g, '')}</Text>
        </LinearGradient>
      </TouchableOpacity>
    );
  };

  const renderVersusCard = ({ item }: { item: any }) => {
    const isMyMatch = user && item.userA && item.userA.uid === user.uid;
    const entryFee = item.entryFee ? item.entryFee / 2 : 0;
    
    // Placeholder visuals
    const placeholderBg = isDark ? '#2C2C2E' : '#F0F0F0';
    const iconColor = isDark ? '#555' : '#CCC';
    const textColorPlaceholder = isDark ? '#777' : '#999';

    return (
      <TouchableOpacity 
        style={[styles.versusCard, { backgroundColor: cardBg }]}
        activeOpacity={0.95}
        onPress={() => handleAction(() => {
            if (isMyMatch) {
                alert("This is your own contest! Wait for someone to join.");
                return;
            }
            router.push({ 
                pathname: item.type === 'video' ? '/contest/video' : '/contest/photo', 
                params: { matchId: item.id, mode: 'join' } 
            });
        })}
      >
        {/* Header: Title & Fee */}
        <View style={styles.vsHeader}>
           <Text style={[styles.vsTitle, { color: textColor }]} numberOfLines={1}>{item.title || 'Battle'}</Text>
           <View style={styles.vsFeeContainer}>
             <Text style={styles.vsFeeLabel}>ENTRY</Text>
             <Text style={styles.vsFeeValue}>{entryFee} 🪙</Text>
           </View>
        </View>

        {/* The Battle Arena (Split View) */}
        <View style={styles.arenaContainer}>
            {/* Left Fighter (User A) */}
            <View style={styles.fighterContainer}>
                {item.userA && item.userA.mediaUrl ? (
                    <Image source={{ uri: item.userA.mediaUrl }} style={styles.fighterImage} />
                ) : (
                    <View style={[styles.fighterImage, { backgroundColor: '#333' }]} />
                )}
                <View style={styles.fighterInfo}>
                    <Text style={styles.fighterName} numberOfLines={1}>@{item.userA?.username}</Text>
                </View>
            </View>

            {/* VS Badge Center */}
            <View style={styles.vsBadge}>
                <Text style={styles.vsText}>VS</Text>
            </View>

            {/* Right Fighter (Placeholder) */}
            <View style={[styles.fighterContainer, { backgroundColor: placeholderBg, borderLeftWidth: 1, borderLeftColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)' }]}>
                 <View style={styles.placeholderInner}>
                     {/* Fallback to simple Text if icon fails, but trying simpler icon first */}
                     <Text style={{ fontSize: 40, color: iconColor, fontWeight: 'bold' }}>?</Text>
                     <Text style={[styles.joinText, { color: textColorPlaceholder }]}>
                        {isMyMatch ? 'Waiting...' : 'You?'}
                     </Text>
                 </View>
            </View>
        </View>

        {/* Action Button */}
        <View style={[styles.actionButton, { backgroundColor: isMyMatch ? '#FFB300' : primaryColor }]}>
            <Text style={styles.actionButtonText}>
                {isMyMatch ? 'WAITING FOR OPPONENT' : 'ACCEPT CHALLENGE'}
            </Text>
            {!isMyMatch && <Ionicons name="arrow-forward" size={16} color="#FFF" style={{ marginLeft: 5 }} />}
        </View>

      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]}>
      <View style={styles.header}>
        <Text style={[styles.headerTitle, { color: textColor }]}>Explore</Text>
        <TouchableOpacity style={[styles.searchButton, { backgroundColor: isDark ? '#333' : '#E5E5EA' }]}>
           <Ionicons name="search" size={20} color={textColor} />
        </TouchableOpacity>
      </View>

      {loading ? (
        <ActivityIndicator size="large" color={primaryColor} style={{marginTop: 50}} />
      ) : (
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 100 }}>
          
          {/* Create New Section */}
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
               <Text style={[styles.sectionTitle, { color: textColor }]}>Create New</Text>
               <TouchableOpacity onPress={() => handleAction(() => router.push('/explore/leaderboard'))}>
                  <Text style={{ color: accentColor, fontFamily: 'Urbanist-Bold' }}>Leaderboard</Text>
               </TouchableOpacity>
            </View>
            <FlatList
              horizontal
              data={availableContests}
              renderItem={renderContestTag}
              keyExtractor={(item) => item.id}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingLeft: 16 }}
            />
          </View>

          {/* Active Battles Section */}
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={[styles.sectionTitle, { color: textColor }]}>Open Battles</Text>
              <TouchableOpacity onPress={fetchExploreData}>
                <Ionicons name="refresh" size={20} color={textColor} />
              </TouchableOpacity>
            </View>
            
            <FlatList
              data={waitingMatches}
              renderItem={renderVersusCard}
              keyExtractor={(item) => item.id}
              scrollEnabled={false}
              contentContainerStyle={{ paddingHorizontal: 16 }}
              ListEmptyComponent={
                <View style={styles.emptyContainer}>
                  <MaterialCommunityIcons name="sword-cross" size={48} color={subTextColor} style={{ marginBottom: 10, opacity: 0.5 }} />
                  <Text style={{ color: subTextColor, fontFamily: 'Urbanist-Medium' }}>No open battles.</Text>
                  <Text style={{ color: primaryColor, fontFamily: 'Urbanist-Bold', marginTop: 5 }}>Be the first to start!</Text>
                </View>
              }
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
  header: { 
    flexDirection: 'row', 
    justifyContent: 'space-between', 
    alignItems: 'center', 
    paddingHorizontal: 20,
    paddingTop: 10,
    marginBottom: 10
  },
  headerTitle: { fontSize: 34, fontFamily: 'Urbanist-Bold' },
  searchButton: { padding: 10, borderRadius: 50 },
  
  section: { marginTop: 24 },
  sectionHeader: { 
    flexDirection: 'row', 
    justifyContent: 'space-between', 
    alignItems: 'center', 
    paddingHorizontal: 20, 
    marginBottom: 15 
  },
  sectionTitle: { fontSize: 20, fontFamily: 'Urbanist-Bold' },
  
  // Category Cards
  categoryCard: {
      marginRight: 12,
      borderRadius: 16,
      overflow: 'hidden',
      height: 80,
      width: 130,
  },
  categoryGradient: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      padding: 10
  },
  categoryText: {
      color: '#FFF',
      fontFamily: 'Urbanist-Bold',
      marginTop: 5,
      fontSize: 14
  },

  // Versus Card
  versusCard: {
      borderRadius: 20,
      marginBottom: 20,
      padding: 12,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.1,
      shadowRadius: 10,
      elevation: 5,
  },
  vsHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 12,
      paddingHorizontal: 4
  },
  vsTitle: { fontSize: 16, fontFamily: 'Urbanist-Bold', flex: 1 },
  vsFeeContainer: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255, 215, 0, 0.15)', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 },
  vsFeeLabel: { fontSize: 10, fontFamily: 'Urbanist-Bold', color: '#F5A623', marginRight: 4 },
  vsFeeValue: { fontSize: 12, fontFamily: 'Urbanist-Black', color: '#F5A623' },

  arenaContainer: {
      flexDirection: 'row',
      height: 160,
      borderRadius: 16,
      overflow: 'hidden',
      position: 'relative'
  },
  fighterContainer: {
      flex: 1,
      // backgroundColor set dynamically in render
      position: 'relative'
  },
  fighterImage: { width: '100%', height: '100%', resizeMode: 'cover' },
  
  placeholderInner: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      width: '100%',
  },
  
  fighterInfo: {
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      padding: 8,
      backgroundColor: 'rgba(0,0,0,0.6)'
  },
  fighterName: { color: '#FFF', fontFamily: 'Urbanist-Bold', fontSize: 12, textAlign: 'center' },
  joinText: { marginTop: 5, fontFamily: 'Urbanist-Bold', fontSize: 14 },

  vsBadge: {
      position: 'absolute',
      top: '50%',
      left: '50%',
      marginLeft: -20,
      marginTop: -20,
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: '#FF3B30',
      justifyContent: 'center',
      alignItems: 'center',
      zIndex: 10,
      borderWidth: 3,
      borderColor: '#FFF',
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.3,
      shadowRadius: 3,
  },
  vsText: { color: '#FFF', fontFamily: 'Urbanist-Black', fontStyle: 'italic', fontSize: 14 },

  actionButton: {
      marginTop: 12,
      paddingVertical: 12,
      borderRadius: 12,
      flexDirection: 'row',
      justifyContent: 'center',
      alignItems: 'center'
  },
  actionButtonText: {
      color: '#FFF',
      fontFamily: 'Urbanist-Bold',
      fontSize: 14,
      letterSpacing: 0.5
  },

  emptyContainer: { padding: 40, alignItems: 'center', width: width }
});
