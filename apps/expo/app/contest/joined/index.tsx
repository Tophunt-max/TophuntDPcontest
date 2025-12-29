import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Share, Dimensions, Image } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useThemeColor } from '@/hooks/use-theme-color';

const { width } = Dimensions.get('window');

export default function ContestJoinedScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const contestName = params.contestName as string || "Photo Contest";
  
  const bgColor = useThemeColor({}, 'background');
  const textColor = useThemeColor({}, 'text');
  const cardBg = useThemeColor({ light: '#FFF', dark: '#1F222A' }, 'background');

  const handleShare = async () => {
    try {
      await Share.share({
        message: `I just joined the ${contestName} battle! 📸 Come compete with me and win coins! 🏆 #PhotoContest`,
      });
    } catch (error) {
      console.log(error);
    }
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: bgColor }]}>
      <View style={styles.content}>
        
        {/* Success Icon */}
        <View style={styles.iconContainer}>
            <LinearGradient
                colors={['#4CAF50', '#81C784']}
                style={styles.successCircle}
            >
                <Ionicons name="checkmark" size={60} color="#FFF" />
            </LinearGradient>
        </View>

        <Text style={[styles.title, { color: textColor }]}>Congratulations! 🎉</Text>
        <Text style={styles.subtitle}>
            You have successfully joined the{"\n"}
            <Text style={{ fontWeight: 'bold', color: '#FF4D67' }}>{contestName}</Text>
        </Text>

        {/* Info Card */}
        <View style={[styles.infoCard, { backgroundColor: cardBg }]}>
            <Text style={[styles.infoText, { color: textColor }]}>
                Your entry is now live! Waiting for an opponent to match with you. Good luck! 🍀
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
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  content: { width: width * 0.9, alignItems: 'center' },
  
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
