import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useThemeColor } from '@/hooks/use-theme-color';
import LottieView from 'lottie-react-native';
import { BottomNav } from '@/src/components/home/BottomNav';
import { useColorScheme } from 'react-native';
import { Colors } from '@/constants/theme';

export default function VideoFeedScreen() {
  const router = useRouter();
  const bgColor = useThemeColor({}, 'background');
  const textColor = useThemeColor({}, 'text');
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;

  return (
    <SafeAreaView style={[styles.container, {backgroundColor: bgColor}]} edges={['top', 'left', 'right']}>
      <View style={styles.header}>
        <Text style={[styles.title, {color: textColor}]}>Video Feed</Text>
      </View>
      
      <View style={styles.centered}>
         <LottieView
            source={{ uri: 'https://lottie.host/9d82136e-d39d-4e2b-bb2a-45c1a166042a/5zT7k52aZ6.json' }} 
            autoPlay
            loop
            style={styles.lottie}
        />
        <Text style={[styles.comingSoonText, { color: textColor }]}>Coming Soon!</Text>
        <Text style={[styles.subText, { color: '#9E9E9E' }]}>
            Get ready for an immersive video experience! 🎥
        </Text>
      </View>

      <View style={styles.navContainer}>
        <BottomNav backgroundColor={backgroundColor} isDark={isDark} />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { padding: 16, alignItems: 'center', borderBottomWidth: 1, borderBottomColor: 'rgba(0,0,0,0.05)' },
  title: { fontSize: 22, fontFamily: 'Urbanist-Bold' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 30, paddingBottom: 100 },
  lottie: { width: 250, height: 250 },
  comingSoonText: { fontSize: 28, fontFamily: 'Urbanist-Bold', marginTop: 20, textAlign: 'center' },
  subText: { fontSize: 16, fontFamily: 'Urbanist-Medium', marginTop: 10, textAlign: 'center', lineHeight: 24 },
  navContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
  }
});
