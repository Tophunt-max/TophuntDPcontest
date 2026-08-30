import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Image,
  ScrollView,
  useWindowDimensions,
  TouchableOpacity,
} from 'react-native';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getAppConfig } from '../../src/services/appSettings';
import { Colors } from '@/constants/theme';
import { designWidth, PHONE_MAX_WIDTH } from '@/src/lib/layout';

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
  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;

  // Reactive, so a desktop resize re-lays out the pages instead of leaving them
  // sized for the window the user first loaded.
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  // Bounded by HEIGHT as well as width. Width alone is not enough: a wide but
  // short desktop window (1280x577 is typical) gave a 336px-tall image that, with
  // its 40px margin, left no room for the title and description — the whole point
  // of an onboarding slide — so they sat below the fold on a screen most people
  // never think to scroll. 32% of the window keeps the copy visible.
  const artSize = Math.min(designWidth(windowWidth) * 0.8, windowHeight * 0.32);

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
    // The page must be exactly the window width for `pagingEnabled` to land on
    // slide boundaries. That is why this is `windowWidth` and not clamped — and
    // why it has to come from `useWindowDimensions()`: read once at module scope,
    // resizing a desktop browser left every page the old width and paging drifted
    // progressively further off-slide.
    <View style={[styles.itemContainer, { width: windowWidth }]}>
      {/*
        Each slide scrolls vertically on its own. The art is tall, and on a short
        or zoomed window the description and the Next button were simply cut off
        with no way to reach them — the FlatList clips its pages, so there was not
        even a clue that anything was missing.
      */}
      <ScrollView
        style={styles.itemScroll}
        contentContainerStyle={styles.itemScrollContent}
        showsVerticalScrollIndicator={false}
      >
        <Image
          source={item.image}
          // Clamped: at 1280px wide this was a 1024x1024 image, which on its own
          // is taller than most desktop viewports.
          style={[styles.image, { width: artSize, height: artSize }]}
          resizeMode="contain"
        />
        <View style={styles.textContainer}>
          <Text style={[styles.title, isDark && styles.textDark]}>{item.title}</Text>
          <Text style={[styles.description, { color: isDark ? '#E0E0E0' : '#616161' }]}>{item.description}</Text>
        </View>
      </ScrollView>
    </View>
  );

  return (
    <View style={[styles.container, { backgroundColor }]}>
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
        <View style={styles.footerInner}>
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
            
            <TouchableOpacity style={[styles.skipButton, { backgroundColor: isDark ? '#35383F' : '#FEF1F3' }]} onPress={handleFinishOnboarding}>
                <Text style={[styles.skipButtonText, isDark && styles.textDark]}>Skip</Text>
            </TouchableOpacity>
        </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  // Width is applied inline from `useWindowDimensions` — a StyleSheet is created
  // once at module load, so a width baked in here could never track a resize.
  itemContainer: { alignItems: 'center' },
  itemScroll: { flex: 1 },
  // flexGrow, not flex: inside a ScrollView `flex: 1` sets `flex-basis: 0` and
  // collapses the content box back to the viewport, which is exactly the clipping
  // being fixed. `justifyContent: center` keeps a short slide centred as before.
  itemScrollContent: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
    // Was 80. With the slide now centred and vertical space at a premium on a
    // short window, a fixed 80px head start only pushed the copy off screen.
    paddingTop: 24,
    paddingBottom: 24,
  },
  image: { marginBottom: 24 },
  textContainer: { alignItems: 'center', paddingHorizontal: 10 },
  title: { fontSize: 28, fontFamily: 'Urbanist-Bold', textAlign: 'center', marginBottom: 16, color: '#212121' },
  description: { fontSize: 16, fontFamily: 'Urbanist-Regular', textAlign: 'center', lineHeight: 24 },
  textDark: { color: '#fff' },
  footer: { paddingHorizontal: 24, paddingBottom: 40, alignItems: 'center' },
  // Caps Next/Skip at phone width instead of letting them span a 1280px window.
  // A no-op below 420px, i.e. on every phone.
  footerInner: { width: '100%', maxWidth: PHONE_MAX_WIDTH, alignItems: 'center' },
  pagination: { flexDirection: 'row', marginBottom: 40 },
  dot: { height: 8, borderRadius: 4, marginHorizontal: 4 },
  activeDot: { width: 24, backgroundColor: '#FF4D67' },
  inactiveDot: { width: 8, backgroundColor: '#E0E0E0' },
  inactiveDotDark: { backgroundColor: '#424242' },
  buttonContainer: { width: '100%' },
  nextButton: { backgroundColor: '#FF4D67', borderRadius: 100, height: 58, justifyContent: 'center', alignItems: 'center', marginBottom: 16 },
  nextButtonText: { color: '#fff', fontSize: 16, fontFamily: 'Urbanist-Bold' },
  skipButton: { height: 58, justifyContent: 'center', alignItems: 'center', borderRadius: 100 },
  skipButtonText: { color: '#FF4D67', fontFamily: 'Urbanist-Bold', fontSize: 16 },
});
