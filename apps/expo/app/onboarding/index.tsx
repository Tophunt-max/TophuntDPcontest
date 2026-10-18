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
import { ONBOARDING_SEEN_KEY } from '../../src/lib/onboarding';
import { loginHref } from '../../src/lib/authGate';
import { Ionicons } from '@/src/lib/icons';
import { Colors } from '@/constants/theme';
import { designWidth, PHONE_MAX_WIDTH, useDesignWindow } from '@/src/lib/layout';

/**
 * The first-launch intro: what TopHunt is, in three slides. Shown once to a new
 * guest (see src/lib/onboarding.ts); Skip is always available. An admin can
 * override a slide's title and image through app config (`onboarding`).
 */
const DEFAULT_ONBOARDING = [
  {
    id: '1',
    title: 'Photo & video battles',
    description: 'Two entries go head to head. Watch live battles from creators all over India.',
    image: require('../../assets/images/onBordingLight1.png'),
  },
  {
    id: '2',
    title: 'You decide the winner',
    description: 'Vote for your favourite, like, comment and follow the creators you love.',
    image: require('../../assets/images/onBordingLight2.png'),
  },
  {
    id: '3',
    title: 'Enter and win',
    description: 'Join a contest with your best photo or video and win coins and prizes.',
    image: require('../../assets/images/onBordingLight3.png'),
  },
  // No bundled art for these two: they draw an icon badge (see `SlideArt`).
  // An admin can upload a picture for any slide from the panel's Onboarding page.
  {
    id: '4',
    title: 'Follow creators & Stories',
    description: 'Follow the people you like and catch their Stories and new battles first.',
    image: null,
    icon: 'people',
  },
  {
    id: '5',
    title: 'Rewards every day',
    description: 'Claim daily rewards, invite friends and grow your coin wallet.',
    image: null,
    icon: 'gift',
  },
];

type Slide = { id: string; title: string; description: string; image: any; icon?: string };

/** Slide picture: an uploaded/bundled image, else an icon badge in the brand colour. */
function SlideArt({ slide, size, isDark }: { slide: Slide; size: number; isDark: boolean }) {
  if (slide.image) {
    return <Image source={slide.image} style={[styles.image, { width: size, height: size }]} resizeMode="contain" />;
  }
  return (
    <View
      style={[
        styles.image,
        styles.iconArt,
        { width: size * 0.8, height: size * 0.8, borderRadius: size * 0.4, backgroundColor: isDark ? '#2A1F24' : '#FEF1F3' },
      ]}
    >
      <Ionicons name={(slide.icon || 'flame') as any} size={size * 0.34} color="#FF4D67" />
    </View>
  );
}

/**
 * Admin slides (appConfig.onboarding) replace the built-in list. A slide without
 * an uploaded image keeps the built-in art for its position, or an icon past it.
 */
function slidesFromConfig(list: { title?: string; description?: string; imageUrl?: string }[]): Slide[] {
  return list.map((item, index) => {
    const builtIn = DEFAULT_ONBOARDING[index];
    return {
      id: String(index + 1),
      title: item.title || builtIn?.title || '',
      description: item.description || builtIn?.description || '',
      image: item.imageUrl ? { uri: item.imageUrl } : builtIn?.image ?? null,
      icon: builtIn?.icon ?? 'flame',
    };
  });
}

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
  // The width the pager is actually drawn at: the phone column on desktop web
  // (PhoneFrame), the full window everywhere else.
  const { width: pageWidth } = useDesignWindow();

  const [currentIndex, setCurrentIndex] = useState(0);
  const [onboardingData, setOnboardingData] = useState<Slide[]>(DEFAULT_ONBOARDING);
  const flatListRef = useRef<FlatList>(null);

  useEffect(() => {
    async function fetchConfig() {
      const config = await getAppConfig();
      if (config && Array.isArray(config.onboarding) && config.onboarding.length > 0) {
        setOnboardingData(slidesFromConfig(config.onboarding));
      }
    }
    fetchConfig();
  }, []);

  /**
   * Leave the intro for `to`. Marked seen first so it never comes back — and
   * the navigation happens even if storage fails, so nobody is stuck here.
   */
  const finish = async (to: string = '/home') => {
    try {
      await AsyncStorage.setItem(ONBOARDING_SEEN_KEY, 'true');
    } catch (error) {
      console.error('Error saving onboarding status:', error);
    }
    // Guest-first: finish into the public feed; sign-in happens on demand.
    router.replace(to as any);
  };
  const handleFinishOnboarding = () => finish('/home');

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

  const renderItem = ({ item }: { item: Slide }) => (
    // The page must be exactly the pager's width for `pagingEnabled` to land on
    // slide boundaries. On desktop web the pager sits in the phone column
    // (PhoneFrame), so that is the design width, not the browser width. It must be
    // reactive: read once at module scope, resizing a desktop browser left every
    // page the old width and paging drifted further off-slide.
    <View style={[styles.itemContainer, { width: pageWidth }]}>
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
        {/* Clamped: at 1280px wide the art was 1024x1024, taller than most desktop viewports. */}
        <SlideArt slide={item} size={artSize} isDark={isDark} />
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
        // Tells scrollToIndex (the Next button) exactly where each page starts.
        // Without it the list has to measure first, and on web the jump never
        // happened: Next did nothing.
        getItemLayout={(_, index) => ({ length: pageWidth, offset: pageWidth * index, index })}
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
            
            <TouchableOpacity
                style={[styles.skipButton, { backgroundColor: isDark ? '#35383F' : '#FEF1F3' }]}
                onPress={handleFinishOnboarding}
                accessibilityRole="button"
                accessibilityLabel="Skip intro"
            >
                <Text style={[styles.skipButtonText, isDark && styles.textDark]}>Skip</Text>
            </TouchableOpacity>

            {/* Returning users on a new device: straight to sign-in, then Home. */}
            <TouchableOpacity
                style={styles.loginLink}
                onPress={() => finish(loginHref('/home'))}
                accessibilityRole="button"
                accessibilityLabel="Already have an account? Log in"
            >
                <Text style={[styles.loginLinkText, { color: isDark ? '#BDBDBD' : '#616161' }]}>
                    Already have an account? <Text style={styles.loginLinkStrong}>Log in</Text>
                </Text>
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
  iconArt: { alignItems: 'center', justifyContent: 'center', alignSelf: 'center' },
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
  loginLink: { marginTop: 16, minHeight: 36, justifyContent: 'center', alignItems: 'center' },
  loginLinkText: { fontFamily: 'Urbanist-Medium', fontSize: 14 },
  loginLinkStrong: { color: '#FF4D67', fontFamily: 'Urbanist-Bold' },
});
