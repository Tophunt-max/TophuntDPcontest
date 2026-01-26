import React, { useEffect, useState, memo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Dimensions,
  TouchableOpacity,
} from 'react-native';
import { Image } from 'expo-image';
import { Portal } from 'react-native-paper';
import LottieView from 'lottie-react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  interpolate,
  Extrapolation,
  runOnJS,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import * as Icons from '@/assets/svgs';
import { Share as RNShare } from 'react-native';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

interface WinnerResultSheetProps {
  visible: boolean;
  onDismiss: () => void;
  match: any;
  isDark: boolean;
}

export const WinnerResultSheet = ({ visible, onDismiss, match, isDark }: WinnerResultSheetProps) => {
  const translateY = useSharedValue(SCREEN_HEIGHT);
  const scale = useSharedValue(0.8);
  const opacity = useSharedValue(0);
  const [shouldRender, setShouldRender] = useState(false);

  useEffect(() => {
    if (visible) {
      setShouldRender(true);
      translateY.value = withSpring(0, { damping: 15, stiffness: 100 });
      scale.value = withSpring(1);
      opacity.value = withTiming(1, { duration: 300 });
    } else if (shouldRender) {
      translateY.value = withTiming(SCREEN_HEIGHT, { duration: 300 }, (finished) => {
          if (finished) runOnJS(setShouldRender)(false);
      });
      opacity.value = withTiming(0, { duration: 300 });
    }
  }, [visible]);

  if (!shouldRender || !match) return null;

  const winner = match.winnerId === match.userA.uid ? match.userA : match.userB;
  const winnerName = winner.displayName || winner.username || "Winner";
  const rewardText = match.rewardType === 'product' ? match.prizeDescription : 
                    match.rewardType === 'both' ? `${match.prizeDescription} + ${match.winnerReward} Dpcoins` :
                    `${match.winnerReward} Dpcoins`;

  const handleShare = async () => {
      try {
          const message = `🎉 Check out the winner of this battle! ${winnerName} won ${rewardText} on TopHunt! 🏆\n\nhttps://tophunt.app/battle/${match.id}`;
          await RNShare.share({ message });
      } catch (e) {}
  };

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }, { scale: scale.value }],
    opacity: opacity.value,
  }));

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: interpolate(translateY.value, [SCREEN_HEIGHT, 0], [0, 0.7], Extrapolation.CLAMP),
  }));

  return (
    <Portal>
      <View style={StyleSheet.absoluteFill}>
        <Animated.View style={[styles.backdrop, backdropStyle]}>
            <TouchableOpacity style={StyleSheet.absoluteFill} onPress={onDismiss} />
        </Animated.View>

        <View style={styles.container}>
            <Animated.View style={[styles.card, animatedStyle, { backgroundColor: isDark ? '#1F222A' : '#FFFFFF' }]}>
                <LottieView
                    source={{ uri: 'https://assets5.lottiefiles.com/packages/lf20_touohxv0.json' }}
                    autoPlay loop style={styles.confetti} pointerEvents="none"
                />
                
                <LinearGradient colors={['#FFD700', '#FFA500']} style={styles.winnerHeader}>
                    <Text style={styles.headerText}>BATTLE WINNER 🏆</Text>
                </LinearGradient>

                <View style={styles.content}>
                    <View style={styles.imageContainer}>
                        <Image source={{ uri: winner.mediaUrl }} style={styles.winnerImage} contentFit="cover" transition={300} />
                        <View style={styles.crownContainer}>
                            <Text style={{ fontSize: 30 }}>👑</Text>
                        </View>
                    </View>

                    <Text style={[styles.congratsText, { color: isDark ? '#FFF' : '#000' }]}>CONGRATULATIONS!</Text>
                    <Text style={[styles.winnerNameText, { color: '#FF4D67' }]}>{winnerName}</Text>
                    
                    <View style={[styles.rewardCard, { backgroundColor: isDark ? '#2A2D35' : '#FFF5F6' }]}>
                        <Text style={styles.rewardLabel}>WINNER REWARD</Text>
                        <Text style={[styles.rewardValue, { color: isDark ? '#FFF' : '#FF4D67' }]}>{rewardText}</Text>
                    </View>

                    <View style={styles.actionRow}>
                        <TouchableOpacity style={styles.shareButton} onPress={handleShare}>
                            <LinearGradient colors={['#FF4D67', '#FF8A4D']} start={{x:0, y:0}} end={{x:1, y:0}} style={styles.btnGradient}>
                                <Icons.Share_Icon width={20} height={20} color="#FFF" />
                                <Text style={styles.btnText}>Share Win</Text>
                            </LinearGradient>
                        </TouchableOpacity>
                        
                        <TouchableOpacity style={[styles.closeButton, { backgroundColor: isDark ? '#35383F' : '#EEEEEE' }]} onPress={onDismiss}>
                            <Text style={[styles.closeBtnText, { color: isDark ? '#FFF' : '#000' }]}>Close</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </Animated.View>
        </View>
      </View>
    </Portal>
  );
};

const styles = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000' },
  container: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 },
  card: { width: '100%', borderRadius: 32, overflow: 'hidden', elevation: 10 },
  confetti: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 5 },
  winnerHeader: { paddingVertical: 15, alignItems: 'center' },
  headerText: { color: '#FFF', fontSize: 16, fontFamily: 'Urbanist-Black', letterSpacing: 1 },
  content: { padding: 24, alignItems: 'center' },
  imageContainer: { width: 160, height: 160, marginBottom: 20, position: 'relative' },
  winnerImage: { width: 160, height: 160, borderRadius: 80, borderWidth: 4, borderColor: '#FFD700' },
  crownContainer: { position: 'absolute', top: -20, left: '38%', zIndex: 10 },
  congratsText: { fontSize: 14, fontFamily: 'Urbanist-Black', letterSpacing: 2, marginBottom: 5 },
  winnerNameText: { fontSize: 24, fontFamily: 'Urbanist-Bold', marginBottom: 20 },
  rewardCard: { width: '100%', padding: 16, borderRadius: 20, alignItems: 'center', marginBottom: 24 },
  rewardLabel: { fontSize: 10, fontFamily: 'Urbanist-Black', color: '#9E9E9E', marginBottom: 4 },
  rewardValue: { fontSize: 16, fontFamily: 'Urbanist-Bold', textAlign: 'center' },
  actionRow: { flexDirection: 'row', gap: 12, width: '100%' },
  shareButton: { flex: 2 },
  btnGradient: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 14, borderRadius: 16, gap: 10 },
  btnText: { color: '#FFF', fontSize: 14, fontFamily: 'Urbanist-Bold' },
  closeButton: { flex: 1, justifyContent: 'center', alignItems: 'center', borderRadius: 16 },
  closeBtnText: { fontSize: 14, fontFamily: 'Urbanist-Bold' },
});
