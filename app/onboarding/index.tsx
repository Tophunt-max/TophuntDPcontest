import React, { useState, useRef, useEffect } from 'react';
import { View, Text, StyleSheet, FlatList, Image, Dimensions, TouchableOpacity, useColorScheme } from 'react-native';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getAppConfig } from '../../src/services/appSettings';

const { width } = Dimensions.get('window');

const DEFAULT_ONBOARDING = [
  {
    id: '1',
    title: 'The Best Social Media App of the Century',
    description: 'Connect with people all over the world and share your moments.',
    image: require('../../assets/images/onBordingLight1.png'),
  },
  {
    id: '2',
    title: 'Let\'s Connect with Everyone in the World',
    description: 'Building a community that values your privacy and creativity.',
    image: require('../../assets/images/onBordingLight2.png'),
  },
  {
    id: '3',
    title: 'Everything You Can Do in the App',
    description: 'Explore, discover, and express yourself like never before.',
    image: require('../../assets/images/onBordingLight3.png'),
  },
];

export default function OnboardingScreen() {
  const router = useRouter();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const [currentIndex, setCurrentIndex] = useState(0);
  const [onboardingData, setOnboardingData] = useState<any[]>(DEFAULT_ONBOARDING);
  const flatListRef = useRef<FlatList>(null);

  useEffect(() => {
    async function fetchConfig() {
      const config = await getAppConfig();
      if (config && config.onboarding && config.onboarding.length > 0) {
        const mergedData = config.onboarding.map((item, index) => ({
          id: String(index + 1),
          title: item.title || DEFAULT_ONBOARDING[index].title,
          description: DEFAULT_ONBOARDING[index].description,
          image: item.imageUrl ? { uri: item.imageUrl } : DEFAULT_ONBOARDING[index].image,
        }));
        setOnboardingData(mergedData);
      }
    }
    fetchConfig();
  }, []);

  const handleFinishOnboarding = async () => {
    try {
      await AsyncStorage.setItem('hasSeenOnboarding', 'true');
      router.replace('/auth/login');
    } catch (error) {
      console.error('Error saving onboarding status:', error);
    }
  };

  const handleNext = () => {
    if (currentIndex < onboardingData.length - 1) {
      flatListRef.current?.scrollToIndex({
        index: currentIndex + 1,
        animated: true,
      });
    } else {
      handleFinishOnboarding();
    }
  };

  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: any[] }) => {
    if (viewableItems.length > 0) {
      setCurrentIndex(viewableItems[0].index);
    }
  }).current;

  const viewConfig = useRef({ viewAreaCoveragePercentThreshold: 50 }).current;

  const renderItem = ({ item }: { item: any }) => (
    <View style={styles.itemContainer}>
      <Image source={item.image} style={styles.image} resizeMode="contain" />
      <View style={styles.textContainer}>
        <Text style={[styles.title, isDark && styles.textDark]}>{item.title}</Text>
        <Text style={[styles.description, isDark && styles.textDark]}>{item.description}</Text>
      </View>
    </View>
  );

  return (
    <View style={[styles.container, isDark && styles.containerDark]}>
      <FlatList
        ref={flatListRef}
        data={onboardingData}
        renderItem={renderItem}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        keyExtractor={(item) => item.id}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={viewConfig}
        scrollEventThrottle={32}
      />

      <View style={styles.footer}>
        <View style={styles.pagination}>
          {onboardingData.map((_, index) => (
            <View
              key={index}
              style={[
                styles.dot,
                currentIndex === index ? styles.activeDot : styles.inactiveDot,
                isDark && currentIndex !== index && styles.inactiveDotDark
              ]}
            />
          ))}
        </View>

        <View style={styles.buttonContainer}>
            <TouchableOpacity style={styles.nextButton} onPress={handleNext}>
                <Text style={styles.nextButtonText}>{currentIndex === onboardingData.length - 1 ? 'Get Started' : 'Next'}</Text>
            </TouchableOpacity>
            
            <TouchableOpacity style={styles.skipButton} onPress={handleFinishOnboarding}>
                <Text style={[styles.skipButtonText, isDark && styles.textDark]}>Skip</Text>
            </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  containerDark: { backgroundColor: '#181A20' },
  itemContainer: { width: width, alignItems: 'center', paddingHorizontal: 20, paddingTop: 80 },
  image: { width: width * 0.8, height: width * 0.8, marginBottom: 40 },
  textContainer: { alignItems: 'center', paddingHorizontal: 10 },
  title: { fontSize: 28, fontFamily: 'Urbanist-Bold', textAlign: 'center', marginBottom: 16, color: '#212121' },
  description: { fontSize: 16, fontFamily: 'Urbanist-Regular', textAlign: 'center', color: '#616161', lineHeight: 24 },
  textDark: { color: '#fff' },
  footer: { paddingHorizontal: 24, paddingBottom: 40, alignItems: 'center' },
  pagination: { flexDirection: 'row', marginBottom: 40 },
  dot: { height: 8, borderRadius: 4, marginHorizontal: 4 },
  activeDot: { width: 24, backgroundColor: '#FF4D67' },
  inactiveDot: { width: 8, backgroundColor: '#E0E0E0' },
  inactiveDotDark: { backgroundColor: '#424242' },
  buttonContainer: { width: '100%' },
  nextButton: { backgroundColor: '#FF4D67', borderRadius: 100, height: 58, justifyContent: 'center', alignItems: 'center', marginBottom: 16 },
  nextButtonText: { color: '#fff', fontSize: 16, fontFamily: 'Urbanist-Bold' },
  skipButton: { height: 58, justifyContent: 'center', alignItems: 'center', borderRadius: 100, backgroundColor: '#FEF1F3', width: '100%' },
  skipButtonText: { color: '#FF4D67', fontFamily: 'Urbanist-Bold', fontSize: 16 },
});
