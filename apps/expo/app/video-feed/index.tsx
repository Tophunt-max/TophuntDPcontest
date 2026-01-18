import React from 'react';
import { View, Text, StyleSheet, Dimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useThemeColor } from '@/hooks/use-theme-color';
import LottieView from 'lottie-react-native';
import { BottomNav } from '@/src/components/home/BottomNav';
import { useColorScheme } from 'react-native';
import { Colors } from '@/constants/theme';

const { width } = Dimensions.get('window');

export default function VideoFeedScreen() {
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
        <View style={styles.lottieContainer}>
          <LottieView
              source={{ uri: 'https://lottie.host/9d82136e-d39d-4e2b-bb2a-45c1a166042a/5zT7k52aZ6.json' }} 
              autoPlay
              loop
              style={styles.lottie}
          />
        </View>
        <Text style={[styles.comingSoonText, { color: textColor }]}>Coming Soon!</Text>
        <Text style={[styles.subText, { color: isDark ? '#A0A0A0' : '#616161' }]}>
            We're building something amazing for you. Get ready for an immersive video experience! 🎥
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
  header: { 
    padding: 16, 
    alignItems: 'center', 
    borderBottomWidth: 1, 
    borderBottomColor: 'rgba(0,0,0,0.05)' 
  },
  title: { 
    fontSize: 22, 
    fontFamily: 'Urbanist-Bold' 
  },
  centered: { 
    flex: 1, 
    justifyContent: 'center', 
    alignItems: 'center', 
    padding: 24, 
    paddingBottom: 120 
  },
  lottieContainer: {
    width: width * 0.8,
    height: width * 0.8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  lottie: { 
    width: '100%', 
    height: '100%' 
  },
  comingSoonText: { 
    fontSize: 32, 
    fontFamily: 'Urbanist-Bold', 
    marginTop: 0, 
    textAlign: 'center',
    letterSpacing: 1
  },
  subText: { 
    fontSize: 16, 
    fontFamily: 'Urbanist-Medium', 
    marginTop: 12, 
    textAlign: 'center', 
    lineHeight: 24,
    paddingHorizontal: 20
  },
  navContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
  }
});
