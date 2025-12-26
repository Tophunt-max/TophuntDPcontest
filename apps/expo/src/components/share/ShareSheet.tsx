import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Image,
  TextInput,
  TouchableOpacity,
  Dimensions,
  Pressable,
  Platform,
  ScrollView,
} from 'react-native';
import { Portal } from 'react-native-paper';
import { Ionicons, Feather } from '@expo/vector-icons';
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
import * as Icons from '@/assets/svgs';

const { height: SCREEN_HEIGHT, width: SCREEN_WIDTH } = Dimensions.get('window');
const SHEET_HEIGHT = SCREEN_HEIGHT * 0.75; // Reduced from 0.8

interface User {
  id: string;
  name: string;
  avatar: string;
}

const MOCK_USERS: User[] = [
  { id: '1', name: 'Alex Smith', avatar: 'https://i.pravatar.cc/150?u=alex' },
  { id: '2', name: 'Emma Watson', avatar: 'https://i.pravatar.cc/150?u=emma' },
  { id: '3', name: 'John Doe', avatar: 'https://i.pravatar.cc/150?u=john' },
  { id: '4', name: 'Sarah Parker', avatar: 'https://i.pravatar.cc/150?u=sarah' },
  { id: '5', name: 'Mike Ross', avatar: 'https://i.pravatar.cc/150?u=mike' },
  { id: '6', name: 'Harvey Specter', avatar: 'https://i.pravatar.cc/150?u=harvey' },
];

const SOCIAL_PLATFORMS = [
    { id: 'wa', name: 'WhatsApp', icon: Icons.WhatsApp_Icon, color: '#25D366' },
    { id: 'ms', name: 'Messenger', icon: Icons.Messenger_Icon, color: '#006AFF' },
    { id: 'fb', name: 'Facebook', icon: Icons.Facebook_Social_Icon, color: '#1877F2' },
    { id: 'ig', name: 'Instagram', icon: Icons.Instagram_Social_Icon, color: '#E4405F' },
    { id: 'tw', name: 'Twitter', icon: Icons.Twitter_Icon, color: '#000000' },
    { id: 'tg', name: 'Telegram', icon: Icons.Telegram_Icon, color: '#0088cc' },
    { id: 'sc', name: 'Snapchat', icon: Icons.Snapchat_Icon, color: '#FFFC00' },
];

interface ShareSheetProps {
  visible: boolean;
  onDismiss: () => void;
  isDark: boolean;
}

export const ShareSheet = ({ visible, onDismiss, isDark }: ShareSheetProps) => {
  const translateY = useSharedValue(SHEET_HEIGHT);
  const opacity = useSharedValue(0);
  const [searchQuery, setSearchQuery] = useState('');

  const backgroundColor = isDark ? '#1F222A' : '#FFFFFF';
  const textColor = isDark ? '#FFFFFF' : '#212121';
  const subTextColor = isDark ? '#BDBDBD' : '#616161';
  const inputBg = isDark ? '#1F222A' : '#F5F5F5';
  const borderColor = isDark ? '#35383F' : '#EEEEEE';

  useEffect(() => {
    if (visible) {
      translateY.value = withSpring(0, { damping: 20, stiffness: 90 });
      opacity.value = withTiming(1, { duration: 300 });
    } else {
      translateY.value = withSpring(SHEET_HEIGHT);
      opacity.value = withTiming(0, { duration: 300 });
    }
  }, [visible]);

  const closeSheet = useCallback(() => {
    translateY.value = withSpring(SHEET_HEIGHT, { damping: 20, stiffness: 90 }, (finished) => {
      if (finished) {
        runOnJS(onDismiss)();
      }
    });
    opacity.value = withTiming(0, { duration: 300 });
  }, [onDismiss]);

  const gesture = Gesture.Pan()
    .onUpdate((event) => {
      if (event.translationY > 0) {
        translateY.value = event.translationY;
      }
    })
    .onEnd((event) => {
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
    opacity: interpolate(translateY.value, [0, SHEET_HEIGHT], [0.5, 0], Extrapolation.CLAMP),
  }));

  if (!visible && translateY.value === SHEET_HEIGHT) return null;

  return (
    <Portal>
      <GestureHandlerRootView style={StyleSheet.absoluteFill}>
        <Animated.View style={[styles.backdrop, backdropStyle]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={closeSheet} />
        </Animated.View>

        <GestureDetector gesture={gesture}>
          <Animated.View style={[styles.sheetContainer, animatedStyle, { backgroundColor }]}>
            <View style={styles.header}>
              <View style={[styles.handle, { backgroundColor: isDark ? '#424242' : '#E0E0E0' }]} />
            </View>

            <View style={styles.searchContainer}>
              <View style={[styles.searchBar, { backgroundColor: inputBg }]}>
                <Ionicons name="search" size={20} color={subTextColor} />
                <TextInput
                  placeholder="Search"
                  placeholderTextColor={subTextColor}
                  style={[styles.searchInput, { color: textColor }]}
                  value={searchQuery}
                  onChangeText={setSearchQuery}
                />
              </View>
            </View>

            <View style={{ height: 100 }}>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.userListHorizontal}>
                    {MOCK_USERS.map(user => (
                        <View key={user.id} style={styles.userItem}>
                            <View style={styles.userAvatarWrapper}>
                                <Image source={{ uri: user.avatar }} style={styles.userAvatar} />
                            </View>
                            <Text style={[styles.userName, { color: textColor }]} numberOfLines={1}>{user.name.split(' ')[0]}</Text>
                        </View>
                    ))}
                </ScrollView>
            </View>

            <View style={[styles.socialSection, { borderTopColor: borderColor }]}>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.socialScrollContent}>
                    {SOCIAL_PLATFORMS.map(platform => {
                        const SocialIcon = platform.icon;
                        return (
                            <TouchableOpacity key={platform.id} style={styles.socialItem}>
                                <View style={[styles.socialIconCircle, { backgroundColor: platform.color }]}>
                                    <SocialIcon width={28} height={28} color={platform.id === 'sc' ? '#000' : '#FFF'} />
                                </View>
                                <Text style={[styles.socialLabel, { color: textColor }]}>{platform.name}</Text>
                            </TouchableOpacity>
                        );
                    })}
                </ScrollView>
            </View>

            <View style={[styles.bottomActions, { borderTopColor: borderColor }]}>
                <TouchableOpacity style={styles.actionBtn}>
                    <View style={[styles.actionIconCircle, { backgroundColor: isDark ? '#2A2E38' : '#F5F5F5' }]}>
                        <Icons.Link_Icon width={28} height={28} color={textColor} />
                    </View>
                    <Text style={[styles.actionLabel, { color: textColor }]}>Copy link</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.actionBtn}>
                    <View style={[styles.actionIconCircle, { backgroundColor: isDark ? '#2A2E38' : '#F5F5F5' }]}>
                        <Icons.Share_Icon width={28} height={28} color={textColor} />
                    </View>
                    <Text style={[styles.actionLabel, { color: textColor }]}>Share to...</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.actionBtn}>
                    <View style={[styles.actionIconCircle, { backgroundColor: isDark ? '#2A2E38' : '#F5F5F5' }]}>
                        <Icons.Download_Icon width={28} height={28} color={textColor} />
                    </View>
                    <Text style={[styles.actionLabel, { color: textColor }]}>Download</Text>
                </TouchableOpacity>
            </View>
          </Animated.View>
        </GestureDetector>
      </GestureHandlerRootView>
    </Portal>
  );
};

const styles = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000' },
  sheetContainer: { position: 'absolute', bottom: 0, left: 0, right: 0, height: SHEET_HEIGHT, borderTopLeftRadius: 30, borderTopRightRadius: 30, overflow: 'hidden' },
  header: { alignItems: 'center', paddingVertical: 12 },
  handle: { width: 40, height: 5, borderRadius: 2.5 },
  searchContainer: { paddingHorizontal: 16, marginBottom: 15 },
  searchBar: { flexDirection: 'row', alignItems: 'center', height: 45, borderRadius: 12, paddingHorizontal: 12 },
  searchInput: { flex: 1, marginLeft: 8, fontFamily: 'Urbanist-Medium', fontSize: 16, outlineStyle: Platform.OS === 'web' ? 'none' : 'auto' } as any,
  userListHorizontal: { paddingLeft: 16, paddingBottom: 5 },
  userItem: { alignItems: 'center', marginRight: 20, width: 60 },
  userAvatarWrapper: { width: 56, height: 56, borderRadius: 28, marginBottom: 6, overflow: 'hidden', backgroundColor: '#eee' },
  userAvatar: { width: '100%', height: '100%' },
  userName: { fontFamily: 'Urbanist-Medium', fontSize: 11, textAlign: 'center' },
  socialSection: { paddingVertical: 10, borderTopWidth: 1 },
  socialScrollContent: { paddingLeft: 16 },
  socialItem: { alignItems: 'center', marginRight: 20, width: 60 },
  socialIconCircle: { width: 48, height: 48, borderRadius: 24, justifyContent: 'center', alignItems: 'center', marginBottom: 6 },
  socialLabel: { fontFamily: 'Urbanist-Medium', fontSize: 10, textAlign: 'center' },
  bottomActions: { flexDirection: 'row', paddingVertical: 12, paddingHorizontal: 16, borderTopWidth: 1, justifyContent: 'space-around', paddingBottom: Platform.OS === 'ios' ? 24 : 12 },
  actionBtn: { alignItems: 'center', flex: 1 },
  actionIconCircle: { width: 48, height: 48, borderRadius: 24, justifyContent: 'center', alignItems: 'center', marginBottom: 6 },
  actionLabel: { fontFamily: 'Urbanist-Medium', fontSize: 11 },
});
