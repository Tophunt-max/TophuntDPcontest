import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, FlatList, ActivityIndicator, Image, TouchableOpacity } from 'react-native';
import { ReanimatedBottomSheet } from './ReanimatedBottomSheet';
import { collection, query, where, getDocs, orderBy, limit } from 'firebase/firestore';
import { firestore as db } from '../../services/firebase/initFirebase';
import { useThemeColor } from '@/hooks/use-theme-color';
import { Trophy_Icon, Wallet_Color, People_Icon, Upvote_Icon } from '@/assets/svgs';
import { getOptimizedMediaUrl } from '@/src/utils/media';

interface StatsDetailModalProps {
  visible: boolean;
  onClose: () => void;
  type: 'wins' | 'battles' | 'votes' | null;
  userId: string;
  onClaimPress: (prize: any) => void;
}

export const StatsDetailModal: React.FC<StatsDetailModalProps> = ({ visible, onClose, type, userId, onClaimPress }) => {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<any[]>([]);
  
  const textColor = useThemeColor({}, 'text');
  const cardBg = useThemeColor({ light: '#F9F9F9', dark: '#2A2D35' }, 'background');
  const subTextColor = useThemeColor({ light: '#888', dark: '#A0A0A5' }, 'text');

  useEffect(() => {
    if (visible && type && userId) {
      fetchData();
    }
  }, [visible, type, userId]);

  const fetchData = async () => {
    setLoading(true);
    try {
      let q;
      if (type === 'wins') {
        q = query(collection(db, "contestMatches"), where("winnerId", "==", userId), orderBy("updatedAt", "desc"), limit(20));
      } else if (type === 'battles') {
        // Find matches where user is either UserA or UserB
        // Firestore doesn't support multiple where in array, so we fetch UserA and UserB separately or use joinIds
        q = query(collection(db, "contestMatches"), where("joinIds", "array-contains", userId), orderBy("createdAt", "desc"), limit(20));
      } else {
        q = query(collection(db, "votes"), where("voterUid", "==", userId), orderBy("timestamp", "desc"), limit(30));
      }

      const snapshot = await getDocs(q);
      setData(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    } catch (e) {
      console.error("Error fetching stats details:", e);
    } finally {
      setLoading(false);
    }
  };

  const renderItem = ({ item }: { item: any }) => {
    if (type === 'wins') {
      const isProduct = item.rewardType === 'product' || item.rewardType === 'both';
      return (
        <View style={[styles.itemCard, { backgroundColor: cardBg }]}>
            <View style={styles.itemHeader}>
                <Trophy_Icon width={24} height={24} color="#FFD700" />
                <Text style={[styles.itemTitle, { color: textColor }]} numberOfLines={1}>{item.title}</Text>
            </View>
            <View style={styles.itemBody}>
                <View style={styles.playerRow}>
                    <Text style={[styles.playerName, { color: subTextColor }]}>VS {item.userA.uid === userId ? item.userB.username : item.userA.username}</Text>
                </View>
                <View style={styles.rewardRow}>
                    {isProduct ? (
                        <View style={styles.productInfo}>
                            <Text style={styles.prizeLabel}>Prize: {item.prizeDescription}</Text>
                            {!item.isPrizeClaimed ? (
                                <TouchableOpacity style={styles.claimBtn} onPress={() => onClaimPress(item)}>
                                    <Text style={styles.claimBtnText}>Claim Now</Text>
                                </TouchableOpacity>
                            ) : (
                                <Text style={styles.claimedText}>Claimed ✅</Text>
                            )}
                        </View>
                    ) : (
                        <View style={styles.coinInfo}>
                            <Wallet_Color width={16} height={16} />
                            <Text style={styles.rewardValue}>+{item.winnerReward} Coins</Text>
                        </View>
                    )}
                </View>
            </View>
        </View>
      );
    }

    if (type === 'battles') {
        const isUserA = item.userA.uid === userId;
        const opponent = isUserA ? item.userB : item.userA;
        return (
            <View style={[styles.itemCard, { backgroundColor: cardBg }]}>
                <View style={styles.itemHeader}>
                    <People_Icon width={20} height={20} color="#FF4D67" />
                    <Text style={[styles.itemTitle, { color: textColor }]}>{item.title}</Text>
                    <Text style={styles.statusBadge}>{item.status.toUpperCase()}</Text>
                </View>
                <View style={styles.battleRow}>
                    <Image source={{ uri: getOptimizedMediaUrl(isUserA ? item.userA.mediaUrl : item.userB?.mediaUrl) }} style={styles.miniMedia} />
                    <Text style={{ color: textColor, marginHorizontal: 10, fontWeight: 'bold' }}>VS</Text>
                    {opponent ? (
                        <View style={styles.opponentBox}>
                            <Image source={{ uri: getOptimizedMediaUrl(opponent.profilePic) }} style={styles.miniAvatar} />
                            <Text style={[styles.playerName, { color: textColor }]}>{opponent.username}</Text>
                        </View>
                    ) : <Text style={styles.waitingText}>Waiting...</Text>}
                </View>
            </View>
        );
    }

    // Default: Votes
    return (
        <View style={[styles.voteItem, { borderBottomColor: cardBg }]}>
            <Upvote_Icon width={20} height={20} color="#4CAF50" />
            <Text style={[styles.voteText, { color: textColor }]}>Voted for <Text style={{fontWeight:'bold'}}>@{item.votedForUsername || 'User'}</Text></Text>
            <Text style={styles.voteTime}>{item.timestamp?.toDate ? item.timestamp.toDate().toLocaleDateString() : 'Recently'}</Text>
        </View>
    );
  };

  const getTitle = () => {
      if (type === 'wins') return "My Victories 🏆";
      if (type === 'battles') return "Battle History ⚔️";
      return "My Votes 🗳️";
  };

  return (
    <ReanimatedBottomSheet visible={visible} onClose={onClose} title={getTitle()} maxHeight={600}>
        {loading ? (
            <ActivityIndicator size="large" color="#FF4D67" style={{ marginVertical: 50 }} />
        ) : (
            <FlatList
                data={data}
                renderItem={renderItem}
                keyExtractor={item => item.id}
                contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 40 }}
                ListEmptyComponent={
                    <View style={styles.emptyState}>
                        <Text style={{ color: subTextColor }}>No records found.</Text>
                    </View>
                }
            />
        )}
    </ReanimatedBottomSheet>
  );
};

const styles = StyleSheet.create({
  itemCard: { padding: 16, borderRadius: 16, marginBottom: 12 },
  itemHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  itemTitle: { fontSize: 16, fontFamily: 'Urbanist-Bold', flex: 1 },
  itemBody: { borderTopWidth: 1, borderTopColor: 'rgba(0,0,0,0.05)', paddingTop: 10 },
  playerRow: { marginBottom: 8 },
  playerName: { fontSize: 13, fontFamily: 'Urbanist-Medium' },
  rewardRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  coinInfo: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rewardValue: { fontSize: 16, color: '#FFD700', fontFamily: 'Urbanist-Bold' },
  productInfo: { flex: 1, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  prizeLabel: { fontSize: 14, color: '#B8860B', fontFamily: 'Urbanist-Bold', flex: 1 },
  claimBtn: { backgroundColor: '#FF4D67', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
  claimBtnText: { color: '#FFF', fontSize: 12, fontFamily: 'Urbanist-Bold' },
  claimedText: { color: '#4CAF50', fontSize: 12, fontFamily: 'Urbanist-Bold' },
  battleRow: { flexDirection: 'row', alignItems: 'center' },
  miniMedia: { width: 50, height: 50, borderRadius: 8, backgroundColor: '#eee' },
  opponentBox: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  miniAvatar: { width: 24, height: 24, borderRadius: 12 },
  statusBadge: { fontSize: 10, backgroundColor: 'rgba(255,77,103,0.1)', color: '#FF4D67', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, overflow: 'hidden' },
  waitingText: { fontSize: 12, color: '#888', fontStyle: 'italic' },
  voteItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 16, borderBottomWidth: 1 },
  voteText: { flex: 1, marginLeft: 12, fontSize: 14, fontFamily: 'Urbanist-Medium' },
  voteTime: { fontSize: 11, color: '#888' },
  emptyState: { padding: 40, alignItems: 'center' }
});
