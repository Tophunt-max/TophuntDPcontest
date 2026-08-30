import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Share, ScrollView, useWindowDimensions, Image } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@/src/lib/icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useThemeColor } from '@/hooks/use-theme-color';
import { designWidth } from '@/src/lib/layout';

/**
 * Contest congratulations screen.
 *
 * Reached from both the create and the join flow via
 * `goToCongratulations` (src/lib/contestSuccess.ts). `mode` distinguishes the
 * two, because the copy is genuinely different: a joiner is immediately live and
 * being voted on, whereas a creator is waiting for an opponent. Previously this
 * screen said "you have successfully joined" in both cases — and in fact was
 * never navigated to at all, so the wording had never been exercised.
 */
export default function ContestJoinedScreen() {
  const router = useRouter();
  // Reactive, unlike the module-scope `Dimensions.get('window')` this replaced,
  // which was captured at bundle load and never tracked a desktop resize.
  const { width: windowWidth } = useWindowDimensions();
  const params = useLocalSearchParams();
  const contestName = params.contestName as string || "Contest";
  const isJoining = params.mode !== 'create';

  const bgColor = useThemeColor({}, 'background');
  const textColor = useThemeColor({}, 'text');
  const cardBg = useThemeColor({ light: '#FFF', dark: '#1F222A' }, 'background');

  const handleShare = async () => {
    try {
      await Share.share({
        message: isJoining
          ? `I just joined the ${contestName} battle on TopHunt! Vote for me and let's win some coins.`
          : `I just started a ${contestName} battle on TopHunt! Come challenge me and win coins.`,
      });
    } catch (error) {
      console.log(error);
    }
  };

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: bgColor }]}>
      {/*
        Scrollable, because this screen carries the two actions a user needs after
        joining (Share, Go to Home). Centred in a fixed-height View they were
        clipped off a short window with no scrollbar, stranding the user on a
        congratulations screen with no way out.
      */}
      <ScrollView contentContainerStyle={styles.container} showsVerticalScrollIndicator={false}>
      {/* Clamped: `width * 0.9` of a 1280px window is a 1152px-wide column. */}
      <View style={[styles.content, { width: designWidth(windowWidth) * 0.9 }]}>
        
        {/* Success Icon */}
        <View style={styles.iconContainer}>
            <LinearGradient
                colors={['#4CAF50', '#81C784']}
                style={styles.successCircle}
            >
                <Ionicons name="checkmark" size={60} color="#FFF" />
            </LinearGradient>
        </View>

        <Text style={[styles.title, { color: textColor }]}>Congratulations!</Text>
        <Text style={styles.subtitle}>
            {isJoining ? 'You have successfully joined the' : 'Your battle is live in'}{"\n"}
            <Text style={{ fontWeight: 'bold', color: '#FF4D67' }}>{contestName}</Text>
        </Text>

        {/* Info Card */}
        <View style={[styles.infoCard, { backgroundColor: cardBg }]}>
            <Text style={[styles.infoText, { color: textColor }]}>
                {isJoining
                  ? 'The battle is now LIVE and fans can vote. Share it to pull in votes — good luck!'
                  : 'Your entry is now live! Waiting for an opponent to match with you. Good luck!'}
            </Text>
        </View>

        {/* Share Button */}
        <TouchableOpacity style={styles.shareButton} onPress={handleShare}>
            <LinearGradient
                colors={['#FF4D67', '#FF8A9B']}
                start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                style={styles.gradientBtn}
            >
                <Ionicons name="share-social" size={24} color="#FFF" />
                <Text style={styles.shareText}>Share with Friends</Text>
            </LinearGradient>
        </TouchableOpacity>

        {/* Go Home Button */}
        <TouchableOpacity style={styles.homeButton} onPress={() => router.replace('/home')}>
            <Text style={[styles.homeText, { color: textColor }]}>Go to Home</Text>
        </TouchableOpacity>

      </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  // flexGrow, not flex — inside a ScrollView `flex: 1` sets `flex-basis: 0`,
  // collapsing the content box back to the viewport and re-clipping the content.
  container: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', paddingVertical: 24 },
  // Width is applied inline from `useWindowDimensions` so it tracks a resize.
  content: { alignItems: 'center' },
  
  iconContainer: { marginBottom: 30, shadowColor: '#4CAF50', shadowOpacity: 0.3, shadowRadius: 15, elevation: 10 },
  successCircle: { width: 120, height: 120, borderRadius: 60, justifyContent: 'center', alignItems: 'center' },
  
  title: { fontSize: 28, fontFamily: 'Urbanist-Bold', marginBottom: 10 },
  subtitle: { fontSize: 16, fontFamily: 'Urbanist-Medium', color: '#888', textAlign: 'center', lineHeight: 24, marginBottom: 30 },
  
  infoCard: { padding: 20, borderRadius: 20, width: '100%', marginBottom: 40, alignItems: 'center', shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 10, elevation: 2 },
  infoText: { fontSize: 15, fontFamily: 'Urbanist-Regular', textAlign: 'center', lineHeight: 22 },
  
  shareButton: { width: '100%', height: 56, borderRadius: 28, overflow: 'hidden', marginBottom: 16, shadowColor: '#FF4D67', shadowOpacity: 0.3, shadowRadius: 10, elevation: 5 },
  gradientBtn: { flex: 1, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 10 },
  shareText: { color: '#FFF', fontSize: 18, fontFamily: 'Urbanist-Bold' },
  
  homeButton: { paddingVertical: 15, paddingHorizontal: 30 },
  homeText: { fontSize: 16, fontFamily: 'Urbanist-Bold', opacity: 0.7 },
});
