import React, { useEffect, useState, useCallback, useRef, memo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Dimensions,
  Pressable,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { Image } from 'expo-image';
import { Portal } from 'react-native-paper';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  runOnJS,
  interpolate,
  Extrapolation,
} from 'react-native-reanimated';
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
} from 'react-native-gesture-handler';
import { firestore } from '@/src/services/firebase/initFirebase';
import { collection, query, where, getDocs, doc, getDoc } from 'firebase/firestore';
import { getOptimizedMediaUrl } from '@/src/utils/media';
import { useRouter } from 'expo-router';
import * as Icons from '@/assets/svgs';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');
const SHEET_HEIGHT = SCREEN_HEIGHT * 0.6;

interface Voter {
  uid: string;
  username: string;
  displayName: string;
  avatar: string;
  votedForUid: string;
}

export const VotersSheet = ({ 
    matchId, 
    visible, 
    onDismiss, 
    isDark,
    userA,
    userB
}: { 
    matchId: string; 
    visible: boolean; 
    onDismiss: () => void; 
    isDark: boolean;
    userA: { uid: string, name: string };
    userB: { uid: string, name: string };
}) => {
  const router = useRouter();
  const translateY = useSharedValue(SCREEN_HEIGHT);
  const [shouldRender, setShouldRender] = useState(false);
  const [voters, setVoters] = useState<Voter[]>([]);
  const [loading, setLoading] = useState(true);

  const backgroundColor = isDark ? '#1F222A' : '#FFFFFF';
  const textColor = isDark ? '#FFFFFF' : '#212121';
  const subTextColor = isDark ? '#BDBDBD' : '#616161';

  useEffect(() => {
    if (visible && matchId) {
      setShouldRender(true);
      translateY.value = withSpring(0, { damping: 20, stiffness: 90 });
      fetchVoters();
    } else if (!visible && shouldRender) {
      translateY.value = withSpring(SCREEN_HEIGHT, { damping: 20, stiffness: 90 }, (finished) => {
          if (finished) runOnJS(setShouldRender)(false);
      });
    }
  }, [visible, matchId]);

  const fetchVoters = async () => {
    setLoading(true);
    try {
      const votesRef = collection(firestore, 'votes');
      const q = query(votesRef, where('matchId', '==', matchId));
      const snap = await getDocs(q);
      
      const voterList: Voter[] = [];
      for (const voteDoc of snap.docs) {
          const voteData = voteDoc.data();
          const userSnap = await getDoc(doc(firestore, 'users', voteData.voterUid));
          if (userSnap.exists()) {
              const u = userSnap.data();
              voterList.push({
                  uid: voteData.voterUid,
                  username: u.username || 'User',
                  displayName: u.displayName || u.username || 'User',
                  avatar: u.profileImageUrl || u.profilePic || '',
                  votedForUid: voteData.votedForUid
              });
          }
      }
      setVoters(voterList);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const closeSheet = useCallback(() => {
    translateY.value = withSpring(SCREEN_HEIGHT, { damping: 20, stiffness: 90 }, (finished) => {
      if (finished) {
        runOnJS(onDismiss)();
        runOnJS(setShouldRender)(false);
      }
    });
  }, [onDismiss]);

  const gesture = Gesture.Pan()
    .onUpdate((event) => {
      'worklet';
      if (event.translationY > 0) {
        translateY.value = event.translationY;
      }
    })
    .onEnd((event) => {
      'worklet';
      if (event.translationY > 150 || event.velocityY > 500) {
        runOnJS(closeSheet)();
      } else {
        translateY.value = withSpring(0, { damping: 20, stiffness: 90 });
      }
    });

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: interpolate(translateY.value, [0, SCREEN_HEIGHT], [0.5, 0], Extrapolation.CLAMP),
  }));

  if (!shouldRender) return null;

  return (
    <Portal>
      <GestureHandlerRootView style={StyleSheet.absoluteFill}>
        <Animated.View style={[styles.backdrop, backdropStyle]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={closeSheet} />
        </Animated.View>

        <GestureDetector gesture={gesture}>
          <Animated.View style={[styles.sheet, animatedStyle, { backgroundColor }]}>
            <View style={styles.header}>
              <View style={[styles.handle, { backgroundColor: isDark ? '#35383F' : '#E0E0E0' }]} />
              <Text style={[styles.title, { color: textColor }]}>Battle Votes</Text>
            </View>

            {loading ? (
                <ActivityIndicator size="large" color="#FF4D67" style={{ marginTop: 50 }} />
            ) : (
                <FlatList
                data={voters}
                keyExtractor={(item) => `${item.uid}_${item.votedForUid}`}
                renderItem={({ item }) => (
                    <TouchableOpacity 
                        style={styles.voterItem}
                        onPress={() => { closeSheet(); router.push(`/profile?userId=${item.uid}`); }}
                    >
                    <Image 
                        source={{ uri: getOptimizedMediaUrl(item.avatar) || `https://ui-avatars.com/api/?name=${item.displayName}` }} 
                        style={styles.avatar} 
                    />
                    <View style={styles.voterInfo}>
                        <Text style={[styles.voterName, { color: textColor }]}>{item.displayName}</Text>
                        <Text style={[styles.votedFor, { color: subTextColor }]}>
                            Voted for <Text style={{ color: '#FF4D67', fontFamily: 'Urbanist-Bold' }}>
                                {item.votedForUid === userA.uid ? userA.name : userB.name}
                            </Text>
                        </Text>
                    </View>
                    </TouchableOpacity>
                )}
                contentContainerStyle={{ padding: 20 }}
                ListEmptyComponent={
                    <View style={{ alignItems: 'center', marginTop: 50 }}>
                        <Text style={{ color: subTextColor, fontFamily: 'Urbanist-Medium' }}>No votes yet</Text>
                    </View>
                }
                />
            )}
          </Animated.View>
        </GestureDetector>
      </GestureHandlerRootView>
    </Portal>
  );
};

const styles = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000' },
  sheet: { position: 'absolute', bottom: 0, left: 0, right: 0, height: SHEET_HEIGHT, borderTopLeftRadius: 30, borderTopRightRadius: 30, elevation: 5 },
  header: { alignItems: 'center', paddingVertical: 12 },
  handle: { width: 40, height: 5, borderRadius: 2.5, marginBottom: 10 },
  title: { fontSize: 18, fontFamily: 'Urbanist-Bold' },
  voterItem: { flexDirection: 'row', alignItems: 'center', marginBottom: 20 },
  avatar: { width: 45, height: 45, borderRadius: 22.5, backgroundColor: '#eee' },
  voterInfo: { marginLeft: 15, flex: 1 },
  voterName: { fontSize: 15, fontFamily: 'Urbanist-Bold' },
  votedFor: { fontSize: 12, fontFamily: 'Urbanist-Medium', marginTop: 2 },
});
