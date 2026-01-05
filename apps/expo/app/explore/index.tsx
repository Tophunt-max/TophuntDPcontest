import React, { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, SafeAreaView, useColorScheme, FlatList, Image, TouchableOpacity, ScrollView, ActivityIndicator, Dimensions, Platform, TextInput, Animated as RNAnimated } from 'react-native';
import { BottomNav } from '@/src/components/home/BottomNav';
import { Ionicons, MaterialCommunityIcons, FontAwesome5 } from '@expo/vector-icons';
import { useRouter, usePathname } from 'expo-router';
import { contestService } from '@/src/services/contests/contestService';
import { fetchSuggestedUsers, toggleFollowService } from '@/src/services/users';
import { useAuth } from '@/src/hooks/useAuth';
import { useProfile } from '@/src/hooks/useProfileData'; 
import { LinearGradient } from 'expo-linear-gradient';
import { useThemeColor } from '@/hooks/use-theme-color';
import { useToast } from '@/src/components/toast/ToastProvider';
import { Colors } from '@/constants/theme';
import FeaturedGrid from '@/src/components/home/FeaturedGrid';

const { width } = Dimensions.get('window');
const CARD_MARGIN = 16;
const CARD_WIDTH = width - (CARD_MARGIN * 2);

export default function DiscoverScreen() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const { data: currentUserProfile } = useProfile(user?.uid || ''); // Fetch current user profile
  const { addToast } = useToast();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  
  // Refined Color Palette
  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background; 
  const cardBg = isDark ? '#1C1C1E' : '#FFFFFF';
  const textColor = isDark ? '#FFFFFF' : '#121212';
  const subTextColor = isDark ? '#A0A0A5' : '#8A8A8E';
  const primaryColor = '#FF3B30'; // Red/Pink accent
  const secondaryColor = '#5856D6'; // Purple accent for Videos
  const usersColor = '#32D74B'; // Green for Users
  const inputBg = isDark ? '#262629' : '#F2F2F7';
  const borderColor = isDark ? '#2C2C2E' : '#E5E5EA';

  const [loading, setLoading] = useState(true);
  const [availableContests, setAvailableContests] = useState<any[]>([]);
  const [waitingMatches, setWaitingMatches] = useState<any[]>([]);
  const [suggestedUsers, setSuggestedUsers] = useState<any[]>([]);
  const [followedUsers, setFollowedUsers] = useState<Set<string>>(new Set());
  
  // State
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'photo' | 'video' | 'users'>('photo');

  // Sync followed users from profile
  useEffect(() => {
    if (currentUserProfile && currentUserProfile.following) {
      setFollowedUsers(new Set(currentUserProfile.following));
    }
  }, [currentUserProfile]);

  useEffect(() => {
    if (!authLoading) {
        fetchExploreData();
    }
  }, [authLoading, user]);

  const fetchExploreData = async () => {
    setLoading(true);
    try {
      const [contests, waiting, usersData] = await Promise.all([
        contestService.getAvailableContests(),
        contestService.getWaitingMatches(undefined, user?.uid),
        fetchSuggestedUsers()
      ]);
      setAvailableContests(contests);
      setWaitingMatches(waiting);
      setSuggestedUsers(usersData);
    } catch (error) {
      console.error("Explore error:", error);
      addToast("Failed to load explore data", "error");
    } finally {
      setLoading(false);
    }
  };

  const handleAction = (action: () => void) => {
      if (!user) {
          const redirect = encodeURIComponent('/explore');
          router.push(`/auth/login?redirect=${redirect}`);
      } else {
          action();
      }
  };

  const handleFollow = async (targetId: string) => {
      handleAction(async () => {
          // Optimistic Update
          const isFollowing = followedUsers.has(targetId);
          setFollowedUsers(prev => {
              const newSet = new Set(prev);
              if (isFollowing) newSet.delete(targetId);
              else newSet.add(targetId);
              return newSet;
          });

          try {
            await toggleFollowService(targetId);
            // addToast(isFollowing ? "Unfollowed" : "Followed successfully!", "success");
          } catch (error) {
            // Revert on failure
            setFollowedUsers(prev => {
                const newSet = new Set(prev);
                if (isFollowing) newSet.add(targetId);
                else newSet.delete(targetId);
                return newSet;
            });
            addToast("Failed to update follow status.", "error");
          }
      });
  };

  // Filtering
  const filteredContests = availableContests.filter(c => 
    (c.type === activeTab || (!c.type && activeTab === 'photo')) &&
    (c.title?.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  const filteredMatches = waitingMatches.filter(m => 
    (m.type === activeTab || (!m.type && activeTab === 'photo')) &&
    (m.title?.toLowerCase().includes(searchQuery.toLowerCase()) || 
     m.userA?.username?.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  const filteredUsers = suggestedUsers.filter(u => 
    u.name?.toLowerCase().includes(searchQuery.toLowerCase()) || 
    u.username?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // --- RENDER COMPONENTS ---

  const renderHeader = () => (
    <View style={styles.headerContainer}>
      <View style={styles.headerTop}>
        <View>
            <Text style={[styles.greeting, { color: subTextColor }]}>Welcome Back,</Text>
            <Text style={[styles.headerTitle, { color: textColor }]}>Explore Arena</Text>
        </View>
        <TouchableOpacity style={[styles.iconBtn, { backgroundColor: inputBg }]} onPress={() => handleAction(() => router.push('/explore/leaderboard'))}>
           <Ionicons name="trophy-outline" size={22} color={primaryColor} />
        </TouchableOpacity>
      </View>

      {/* Featured Grid added here */}
      <View style={{ marginBottom: 20 }}>
        <FeaturedGrid />
      </View>

      {/* Modern Search Bar */}
      <View style={[styles.searchBox, { backgroundColor: isDark ? '#1C1C1E' : '#FFF', borderColor: isDark ? 'transparent' : '#F0F0F0', borderWidth: 1 }]}>
          <Ionicons name="search" size={20} color={activeTab === 'users' ? usersColor : (activeTab === 'video' ? secondaryColor : primaryColor)} style={{ marginRight: 10 }} />
          <TextInput 
              style={[styles.searchInput, { color: textColor }]}
              placeholder={`Search ${activeTab === 'users' ? 'people' : activeTab + ' contests'}...`}
              placeholderTextColor={subTextColor}
              value={searchQuery}
              onChangeText={setSearchQuery}
              returnKeyType="search"
          />
          {searchQuery.length > 0 && (
              <TouchableOpacity onPress={() => setSearchQuery('')}>
                  <Ionicons name="close-circle" size={18} color={subTextColor} />
              </TouchableOpacity>
          )}
      </View>
    </View>
  );

  const renderTabs = () => (
    <View style={styles.tabSection}>
        <View style={[styles.pillContainer, { backgroundColor: isDark ? '#1C1C1E' : '#EEE' }]}>
            <TouchableOpacity 
                style={[styles.pill, activeTab === 'photo' && styles.activePill]} 
                onPress={() => setActiveTab('photo')}
                activeOpacity={0.8}
            >
                <Ionicons name="camera" size={16} color={activeTab === 'photo' ? '#FFF' : subTextColor} style={{ marginRight: 6 }} />
                <Text style={[styles.pillText, { color: activeTab === 'photo' ? '#FFF' : subTextColor }]}>Photos</Text>
            </TouchableOpacity>
            
            <TouchableOpacity 
                style={[styles.pill, activeTab === 'video' && styles.activePillVideo]} 
                onPress={() => setActiveTab('video')}
                activeOpacity={0.8}
            >
                <Ionicons name="videocam" size={16} color={activeTab === 'video' ? '#FFF' : subTextColor} style={{ marginRight: 6 }} />
                <Text style={[styles.pillText, { color: activeTab === 'video' ? '#FFF' : subTextColor }]}>Videos</Text>
            </TouchableOpacity>

            <TouchableOpacity 
                style={[styles.pill, activeTab === 'users' && styles.activePillUsers]} 
                onPress={() => setActiveTab('users')}
                activeOpacity={0.8}
            >
                <Ionicons name="people" size={16} color={activeTab === 'users' ? '#FFF' : subTextColor} style={{ marginRight: 6 }} />
                <Text style={[styles.pillText, { color: activeTab === 'users' ? '#FFF' : subTextColor }]}>People</Text>
            </TouchableOpacity>
        </View>
    </View>
  );

  const renderContestTemplate = ({ item }: { item: any }) => {
    if (!item || !item.title) return null;
    return (
      <TouchableOpacity 
        activeOpacity={0.9}
        onPress={() => handleAction(() => {
            router.push({ 
                pathname: item.type === 'video' ? '/contest/video' : '/contest/photo', 
                params: { contestId: item.id } 
            });
        })}
        style={[styles.templateCard, { backgroundColor: cardBg }]}
      >
         <LinearGradient
            colors={item.type === 'video' ? ['#6A11CB', '#2575FC'] : ['#FF416C', '#FF4B2B']}
            start={{x: 0, y: 0}} end={{x: 1, y: 1}}
            style={styles.templateImage}
         >
             <MaterialCommunityIcons name={item.type === 'video' ? 'movie-open-star' : 'image-filter-hdr'} size={32} color="rgba(255,255,255,0.8)" />
         </LinearGradient>
         <View style={styles.templateInfo}>
             <Text style={[styles.templateTitle, { color: textColor }]} numberOfLines={1}>{item.title}</Text>
             <Text style={[styles.templateSubtitle, { color: subTextColor }]}>Start a Match</Text>
         </View>
         <View style={styles.templateAction}>
             <Ionicons name="add" size={20} color="#FFF" />
         </View>
      </TouchableOpacity>
    );
  };

  const renderVersusCard = ({ item }: { item: any }) => {
    const isMyMatch = user && item.userA && item.userA.uid === user.uid;
    const entryFee = item.entryFee ? item.entryFee / 2 : 0;
    const prize = (item.entryFee || 0);

    return (
      <View style={[styles.matchCardContainer, { backgroundColor: cardBg }]}>
        <View style={styles.matchHeader}>
            <View style={styles.badgeContainer}>
                <View style={[styles.liveIndicator, { backgroundColor: primaryColor }]} />
                <Text style={[styles.matchStatus, { color: textColor }]}>Waiting for Opponent</Text>
            </View>
            <View style={styles.prizeContainer}>
                <Text style={styles.prizeLabel}>Prize Pool:</Text>
                <Text style={[styles.prizeValue, { color: '#FFD700' }]}>{prize} 🪙</Text>
            </View>
        </View>

        <View style={styles.matchBody}>
             <View style={styles.playerSide}>
                 <Image source={{ uri: item.userA?.mediaUrl }} style={styles.mediaPreview} />
                 <LinearGradient 
                    colors={['transparent', 'rgba(0,0,0,0.8)']} 
                    style={styles.mediaOverlay}
                 >
                    <View style={styles.userInfo}>
                        <Image source={{ uri: item.userA?.avatar || 'https://via.placeholder.com/50' }} style={styles.miniAvatar} />
                        <Text style={styles.miniUsername} numberOfLines={1}>{item.userA?.username}</Text>
                    </View>
                 </LinearGradient>
             </View>

             <View style={styles.vsDivider}>
                 <LinearGradient colors={['#FF416C', '#FF4B2B']} style={styles.vsCircle}>
                     <Text style={styles.vsText}>VS</Text>
                 </LinearGradient>
             </View>

             <TouchableOpacity 
                activeOpacity={0.8}
                style={[styles.playerSide, styles.emptySide, { borderColor: isDark ? '#333' : '#EEE' }]}
                onPress={() => handleAction(() => {
                    if (isMyMatch) {
                        addToast("This is your own contest! Wait for someone to join.", "info");
                        return;
                    }
                    router.push({ 
                        pathname: item.type === 'video' ? '/contest/video/setup' : '/contest/photo/setup', 
                        params: { matchId: item.id, mode: 'join' } 
                    });
                })}
             >
                 <View style={styles.joinCircle}>
                    <Ionicons name="add" size={32} color={isDark ? '#555' : '#CCC'} />
                 </View>
                 <Text style={[styles.joinText, { color: subTextColor }]}>{isMyMatch ? 'Waiting...' : 'Tap to Join'}</Text>
                 { !isMyMatch && <Text style={[styles.entryFeeText, { color: primaryColor }]}>Pay {entryFee} 🪙</Text> }
             </TouchableOpacity>
        </View>
        
        <View style={styles.matchFooter}>
             <Text style={[styles.matchTitle, { color: textColor }]} numberOfLines={1}>{item.title || 'Untitled Battle'}</Text>
             {!isMyMatch && (
                 <TouchableOpacity 
                    style={[styles.joinBtn, { backgroundColor: activeTab === 'video' ? secondaryColor : primaryColor }]}
                    onPress={() => handleAction(() => {
                        router.push({ 
                            pathname: item.type === 'video' ? '/contest/video/setup' : '/contest/photo/setup', 
                            params: { matchId: item.id, mode: 'join' } 
                        });
                    })}
                 >
                    <Text style={styles.joinBtnText}>Battle Now</Text>
                 </TouchableOpacity>
             )}
        </View>
      </View>
    );
  };

  const renderUserCard = ({ item }: { item: any }) => {
      const isFollowed = followedUsers.has(item.id);
      return (
      <TouchableOpacity 
        style={[styles.userCard, { backgroundColor: cardBg }]}
        activeOpacity={0.7}
        onPress={() => handleAction(() => router.push(`/profile?userId=${item.id}`))}
      >
          <Image source={{ uri: item.avatar }} style={styles.userAvatar} />
          <View style={styles.userDetails}>
              <Text style={[styles.userName, { color: textColor }]} numberOfLines={1}>{item.name}</Text>
              <Text style={[styles.userHandle, { color: subTextColor }]} numberOfLines={1}>@{item.username}</Text>
          </View>
          <TouchableOpacity 
            style={[
                styles.followBtn, 
                { backgroundColor: isFollowed ? (isDark ? '#333' : '#EEE') : primaryColor }
            ]}
            onPress={() => handleFollow(item.id)}
          >
              <Text style={[
                  styles.followText, 
                  { color: isFollowed ? textColor : '#FFF' }
                ]}>
                  {isFollowed ? 'Following' : 'Follow'}
              </Text> 
          </TouchableOpacity>
      </TouchableOpacity>
  )};

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]}>
        <ScrollView 
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: 100 }}
            stickyHeaderIndices={[1]} // Make Tabs Sticky
        >
            {renderHeader()}
            
            {/* Sticky Tabs */}
            {renderTabs()}

            {loading ? (
                <View style={{ height: 300, justifyContent: 'center' }}>
                    <ActivityIndicator size="large" color={primaryColor} />
                </View>
            ) : (
                <View style={styles.contentSection}>
                    {activeTab === 'users' ? (
                        <View style={{ paddingHorizontal: CARD_MARGIN }}>
                            <View style={styles.sectionHeader}>
                                <Text style={[styles.sectionTitle, { color: textColor }]}>Suggested People</Text>
                            </View>
                            {filteredUsers.length === 0 ? (
                                <Text style={{ color: subTextColor, textAlign:'center', marginTop: 20 }}>No users found.</Text>
                            ) : (
                                filteredUsers.map((item) => (
                                    <View key={item.id} style={{ marginBottom: 12 }}>
                                        {renderUserCard({ item })}
                                    </View>
                                ))
                            )}
                        </View>
                    ) : (
                        <>
                            {/* Create Section */}
                            <View style={styles.sectionHeader}>
                                <Text style={[styles.sectionTitle, { color: textColor }]}>Start a New Battle</Text>
                            </View>
                            
                            <FlatList
                                horizontal
                                data={filteredContests}
                                renderItem={renderContestTemplate}
                                keyExtractor={(item) => item.id}
                                showsHorizontalScrollIndicator={false}
                                contentContainerStyle={{ paddingHorizontal: CARD_MARGIN, paddingBottom: 20 }}
                                ListEmptyComponent={<Text style={{marginLeft: 16, color: subTextColor}}>No templates available.</Text>}
                            />

                            {/* Join Section */}
                            <View style={styles.sectionHeader}>
                                <View style={{flexDirection:'row', alignItems:'center', gap: 6}}>
                                    <Text style={[styles.sectionTitle, { color: textColor }]}>Live Arena</Text>
                                    <View style={{backgroundColor: primaryColor, borderRadius: 4, paddingHorizontal: 4}}>
                                        <Text style={{color:'#FFF', fontSize: 10, fontWeight:'bold'}}>LIVE</Text>
                                    </View>
                                </View>
                                <TouchableOpacity onPress={fetchExploreData}>
                                    <Ionicons name="refresh" size={20} color={subTextColor} />
                                </TouchableOpacity>
                            </View>

                            <View style={{ paddingHorizontal: CARD_MARGIN }}>
                                {filteredMatches.length === 0 ? (
                                    <View style={[styles.emptyState, { borderColor }]}>
                                        <MaterialCommunityIcons name="sword-cross" size={48} color={subTextColor} style={{opacity: 0.5}} />
                                        <Text style={[styles.emptyText, { color: subTextColor }]}>No active battles found.</Text>
                                        <TouchableOpacity onPress={() => handleAction(() => router.push('/explore/leaderboard'))}>
                                            <Text style={{color: primaryColor, fontWeight: 'bold', marginTop: 10}}>Check Leaderboard</Text>
                                        </TouchableOpacity>
                                    </View>
                                ) : (
                                    filteredMatches.map((item) => (
                                        <View key={item.id} style={{ marginBottom: 16 }}>
                                            {renderVersusCard({ item })}
                                        </View>
                                    ))
                                )}
                            </View>
                        </>
                    )}
                </View>
            )}
        </ScrollView>
        <BottomNav backgroundColor={backgroundColor} isDark={isDark} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  
  // Header
  headerContainer: {
      paddingHorizontal: 20,
      paddingTop: 10,
      paddingBottom: 20,
  },
  headerTop: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 15,
  },
  greeting: { fontSize: 14, fontFamily: 'Urbanist-Medium' },
  headerTitle: { fontSize: 32, fontFamily: 'Urbanist-Bold' },
  iconBtn: {
      width: 44,
      height: 44,
      borderRadius: 22,
      justifyContent: 'center',
      alignItems: 'center',
  },
  
  // Search
  searchBox: {
      flexDirection: 'row',
      alignItems: 'center',
      height: 52,
      borderRadius: 16,
      paddingHorizontal: 16,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.05,
      shadowRadius: 10,
      elevation: 2,
  },
  searchInput: {
      flex: 1,
      fontSize: 16,
      fontFamily: 'Urbanist-Medium',
  },

  // Tabs
  tabSection: {
      paddingHorizontal: 20,
      paddingBottom: 10,
      backgroundColor: 'transparent', // Will inherit from parent if sticky
      zIndex: 10,
  },
  pillContainer: {
      flexDirection: 'row',
      padding: 4,
      borderRadius: 20,
  },
  pill: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 10,
      borderRadius: 16,
  },
  activePill: {
      backgroundColor: '#FF3B30', // Primary Red
      shadowColor: "#FF3B30",
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.3,
      shadowRadius: 4,
      elevation: 3,
  },
  activePillVideo: {
      backgroundColor: '#5856D6', // Secondary Purple
      shadowColor: "#5856D6",
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.3,
      shadowRadius: 4,
      elevation: 3,
  },
  activePillUsers: {
      backgroundColor: '#32D74B', // Green for Users
      shadowColor: "#32D74B",
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.3,
      shadowRadius: 4,
      elevation: 3,
  },
  pillText: {
      fontSize: 14,
      fontFamily: 'Urbanist-Bold',
  },

  // Content
  contentSection: {
      marginTop: 10,
  },
  sectionHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: 20,
      marginBottom: 12,
  },
  sectionTitle: {
      fontSize: 20,
      fontFamily: 'Urbanist-Bold',
  },

  // Contest Templates
  templateCard: {
      width: 140,
      height: 180,
      borderRadius: 20,
      marginRight: 12,
      padding: 10,
      justifyContent: 'space-between',
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.1,
      shadowRadius: 8,
      elevation: 4,
  },
  templateImage: {
      width: 50,
      height: 50,
      borderRadius: 15,
      justifyContent: 'center',
      alignItems: 'center',
      marginBottom: 10,
  },
  templateInfo: { flex: 1 },
  templateTitle: { fontSize: 16, fontFamily: 'Urbanist-Bold', marginBottom: 4 },
  templateSubtitle: { fontSize: 12, fontFamily: 'Urbanist-Medium' },
  templateAction: {
      alignSelf: 'flex-end',
      backgroundColor: '#121212',
      borderRadius: 15,
      width: 30,
      height: 30,
      justifyContent: 'center',
      alignItems: 'center',
  },

  // Match Cards (Redesigned)
  matchCardContainer: {
      borderRadius: 24,
      overflow: 'hidden',
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.1,
      shadowRadius: 12,
      elevation: 5,
  },
  matchHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: 'rgba(150,150,150,0.1)',
  },
  badgeContainer: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  liveIndicator: { width: 8, height: 8, borderRadius: 4 },
  matchStatus: { fontSize: 12, fontFamily: 'Urbanist-Bold' },
  prizeContainer: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  prizeLabel: { fontSize: 12, fontFamily: 'Urbanist-Medium', color: '#888' },
  prizeValue: { fontSize: 14, fontFamily: 'Urbanist-Black' },

  matchBody: {
      flexDirection: 'row',
      height: 150,
      alignItems: 'center',
  },
  playerSide: {
      flex: 1,
      height: '100%',
      justifyContent: 'center',
      alignItems: 'center',
  },
  mediaPreview: {
      width: '100%',
      height: '100%',
      resizeMode: 'cover',
  },
  mediaOverlay: {
      ...StyleSheet.absoluteFillObject,
      justifyContent: 'flex-end',
      padding: 10,
  },
  userInfo: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
  },
  miniAvatar: {
      width: 24,
      height: 24,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: '#FFF',
  },
  miniUsername: {
      color: '#FFF',
      fontSize: 12,
      fontFamily: 'Urbanist-Bold',
      textShadowColor: 'rgba(0,0,0,0.5)',
      textShadowOffset: {width: 0, height: 1},
      textShadowRadius: 2,
  },
  
  // VS Divider
  vsDivider: {
      width: 40,
      zIndex: 10,
      alignItems: 'center',
      justifyContent: 'center',
      position: 'absolute',
      left: '50%',
      marginLeft: -20,
  },
  vsCircle: {
      width: 40,
      height: 40,
      borderRadius: 20,
      justifyContent: 'center',
      alignItems: 'center',
      borderWidth: 2,
      borderColor: '#FFF',
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.3,
      shadowRadius: 4,
      elevation: 5,
  },
  vsText: {
      color: '#FFF',
      fontFamily: 'Urbanist-Black',
      fontSize: 12,
      fontStyle: 'italic',
  },

  // Empty Side
  emptySide: {
      borderLeftWidth: 1,
      borderStyle: 'dashed',
      justifyContent: 'center',
      alignItems: 'center',
      backgroundColor: 'rgba(0,0,0,0.02)',
  },
  joinCircle: {
      width: 48,
      height: 48,
      borderRadius: 24,
      borderWidth: 2,
      borderColor: '#E0E0E0',
      borderStyle: 'dashed',
      justifyContent: 'center',
      alignItems: 'center',
      marginBottom: 8,
  },
  joinText: { fontSize: 14, fontFamily: 'Urbanist-Bold' },
  entryFeeText: { fontSize: 12, fontFamily: 'Urbanist-Bold', marginTop: 4 },

  // Match Footer
  matchFooter: {
      padding: 12,
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      backgroundColor: 'rgba(150,150,150,0.05)',
  },
  matchTitle: {
      fontSize: 16,
      fontFamily: 'Urbanist-Bold',
      flex: 1,
      marginRight: 10,
  },
  joinBtn: {
      paddingVertical: 8,
      paddingHorizontal: 16,
      borderRadius: 12,
  },
  joinBtnText: {
      color: '#FFF',
      fontSize: 12,
      fontFamily: 'Urbanist-Bold',
  },
  
  // User Cards
  userCard: {
      flexDirection: 'row',
      alignItems: 'center',
      padding: 12,
      borderRadius: 16,
      marginBottom: 10,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.05,
      shadowRadius: 4,
      elevation: 2,
  },
  userAvatar: {
      width: 50,
      height: 50,
      borderRadius: 25,
      marginRight: 12,
  },
  userDetails: { flex: 1 },
  userName: { fontSize: 16, fontFamily: 'Urbanist-Bold' },
  userHandle: { fontSize: 14, fontFamily: 'Urbanist-Medium' },
  followBtn: {
      paddingVertical: 8,
      paddingHorizontal: 16,
      borderRadius: 20,
  },
  followText: {
      fontSize: 12,
      fontFamily: 'Urbanist-Bold',
  },

  emptyState: {
      borderWidth: 2,
      borderStyle: 'dashed',
      borderRadius: 20,
      padding: 30,
      alignItems: 'center',
      marginTop: 10,
  },
  emptyText: {
      marginTop: 10,
      fontFamily: 'Urbanist-Medium',
  },
});
