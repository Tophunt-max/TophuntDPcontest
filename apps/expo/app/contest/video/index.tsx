import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useThemeColor } from '@/hooks/use-theme-color';
import LottieView from 'lottie-react-native';

const BRAND_PRIMARY = '#FF4D67';

export default function VideoContestScreen() {
  const router = useRouter();
  const bgColor = useThemeColor({}, 'background');
  const textColor = useThemeColor({}, 'text');

  return (
    <SafeAreaView style={[styles.container, {backgroundColor: bgColor}]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={28} color={textColor} />
        </TouchableOpacity>
        <Text style={[styles.title, {color: textColor}]}>Video Contests</Text>
        <View style={{ width: 28 }} />
      </View>
      
      <View style={styles.centered}>
         <LottieView
            source={{ uri: 'https://lottie.host/9d82136e-d39d-4e2b-bb2a-45c1a166042a/5zT7k52aZ6.json' }} // Coming soon rocket or similar
            autoPlay
            loop
            style={styles.lottie}
        />
        <Text style={[styles.comingSoonText, { color: textColor }]}>Coming Soon!</Text>
        <Text style={[styles.subText, { color: '#9E9E9E' }]}>
            Prepare your best moves! Video battles are launching shortly.
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16 },
  title: { fontSize: 22, fontFamily: 'Urbanist-Bold' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 30 },
  lottie: { width: 250, height: 250 },
  comingSoonText: { fontSize: 28, fontFamily: 'Urbanist-Bold', marginTop: 20, textAlign: 'center' },
  subText: { fontSize: 16, fontFamily: 'Urbanist-Medium', marginTop: 10, textAlign: 'center', lineHeight: 24 }
});
