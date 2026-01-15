import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  Dimensions,
  Pressable,
  Platform,
  ScrollView,
  Share as RNShare
} from 'react-native';
import { Image } from 'expo-image';
import { Portal } from 'react-native-paper';
import { Ionicons } from '@expo/vector-icons';
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
import { fetchSuggestedUsers } from '@/src/services/users';
import { contestService } from '@/src/services/contests/contestService';
import { useToast } from '../toast/ToastProvider';
import * as Clipboard from 'expo-clipboard';
import { getOptimizedMediaUrl } from '@/src/utils/media';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');
const SHEET_HEIGHT = SCREEN_HEIGHT * 0.75;

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
  matchId: string;
}

export const ShareSheet = ({ visible, onDismiss, isDark, matchId }: ShareSheetProps) => {
  const translateY = useSharedValue(SHEET_HEIGHT);
  const opacity = useSharedValue(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [users, setUsers] = useState<any[]>([]);
  const { addToast } = useToast();

  const backgroundColor = isDark ? '#1F222A' : '#FFFFFF';
  const textColor = isDark ? '#FFFFFF' : '#212121';
  const subTextColor = isDark ? '#BDBDBD' : '#616161';
  const inputBg = isDark ? '#1F222A' : '#F5F5F5';
  const borderColor = isDark ? '#35383F' : '#EEEEEE';

  useEffect(() => {
    if (visible) {
      translateY.value = withSpring(0, { damping: 20, stiffness: 90 });
      opacity.value = withTiming(1, { duration: 300 });
      loadUsers();
    } else {
      translateY.value = withSpring(SHEET_HEIGHT);
      opacity.value = withTiming(0, { duration: 300 });
    }
  }, [visible]);

  const loadUsers = async () => {
    try {
      const suggestedUsers = await fetchSuggestedUsers();
      setUsers(suggestedUsers);
    } catch (e) {
      console.error(e);
    }
  };

  const handleShareSuccess = async () => {
    try {
      await contestService.shareMatch(matchId);
    } catch (e) {
      console.error("Failed to increment share count:", e);
    }
  };

  const onShareAction = async (platformName: string) => {
    try {
      const shareUrl = `https://tophunt.app/battle/${matchId}`;
      const message = `Check out this battle on TopHunt! 🏆\n\n${shareUrl}`;
      
      const result = await RNShare.share({
        message,
        url: shareUrl,
        title: 'Share Battle'
      });

      if (result.action === RNShare.sharedAction) {
        await handleShareSuccess();
        addToast(`Shared to ${platformName}! 🔥`, 'success');
        closeSheet();
      }
    } catch (error: any) {
      addToast(error.message, 'error');
    }
  };

  const onCopyLink = async () => {
    const shareUrl = `https://tophunt.app/battle/${matchId}`;
    await Clipboard.setStringAsync(shareUrl);
    await handleShareSuccess();
    addToast("Link copied to clipboard! 📋", 'success');
    closeSheet();
  };

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

  const filteredUsers = users.filter(u => 
    u.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
    u.username.toLowerCase().includes(searchQuery.toLowerCase())
  );

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
              <View style={[styles.searchBar, { backgroundColor: inputBg, borderColor }]}>
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

            <View style={{ height: 110 }}>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.userListHorizontal}>
                    {filteredUsers.length > 0 ? filteredUsers.map(user => (
                        <TouchableOpacity key={user.id} style={styles.userItem} onPress={() => onShareAction(user.name)}>
                            <View style={styles.userAvatarWrapper}>
                                <Image 
                                    source={{ uri: getOptimizedMediaUrl(user.avatar) }} 
                                    style={styles.userAvatar} 
                                    contentFit="cover"
                                    cachePolicy="memory-disk"
                                    transition={200}
                                />
                            </View>
                            <Text style={[styles.userName, { color: textColor }]} numberOfLines={1}>{user.name.split(' ')[0]}</Text>
                        </TouchableOpacity>
                    )) : (
                        [1,2,3,4,5,6].map(i => (
                            <View key={i} style={styles.userItem}>
                                <View style={[styles.userAvatarWrapper, { backgroundColor: isDark ? '#2A2E38' : '#F5F5F5' }]} />
                                <View style={{ height: 10, width: 40, backgroundColor: isDark ? '#2A2E38' : '#F5F5F5', borderRadius: 5 }} />
                            </View>
                        ))
                    )}
                </ScrollView>
            </View>

            <View style={[styles.socialSection, { borderTopColor: borderColor }]}>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.socialScrollContent}>
                    {SOCIAL_PLATFORMS.map(platform => {
                        const SocialIcon = platform.icon;
                        return (
                            <TouchableOpacity key={platform.id} style={styles.socialItem} onPress={() => onShareAction(platform.name)}>
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
                <TouchableOpacity style={styles.actionBtn} onPress={onCopyLink}>
                    <View style={[styles.actionIconCircle, { backgroundColor: isDark ? '#2A2E38' : '#F5F5F5' }]}>
                        <Icons.Link_Icon width={28} height={28} color={textColor} />
                    </View>
                    <Text style={[styles.actionLabel, { color: textColor }]}>Copy link</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.actionBtn} onPress={() => onShareAction('Other App')}>
                    <View style={[styles.actionIconCircle, { backgroundColor: isDark ? '#2A2E38' : '#F5F5F5' }]}>
                        <Icons.Share_Icon width={28} height={28} color={textColor} />
                    </View>
                    <Text style={[styles.actionLabel, { color: textColor }]}>Share to...</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.actionBtn} onPress={() => { addToast("Feature coming soon! 🚧", 'info'); }}>
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
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)' },
  sheetContainer: { position: 'absolute', bottom: 0, left: 0, right: 0, height: SHEET_HEIGHT, borderTopLeftRadius: 30, borderTopRightRadius: 30, overflow: 'hidden' },
  header: { alignItems: 'center', paddingVertical: 12 },
  handle: { width: 40, height: 5, borderRadius: 2.5 },
  searchContainer: { paddingHorizontal: 16, marginBottom: 15 },
  searchBar: { flexDirection: 'row', alignItems: 'center', height: 45, borderRadius: 12, paddingHorizontal: 12, borderWidth: 1 },
  searchInput: { flex: 1, marginLeft: 8, fontFamily: 'Urbanist-Medium', fontSize: 16, outlineStyle: Platform.OS === 'web' ? 'none' : 'auto' } as any,
  userListHorizontal: { paddingLeft: 16, paddingBottom: 5 },
  userItem: { alignItems: 'center', marginRight: 20, width: 60 },
  userAvatarWrapper: { width: 56, height: 56, borderRadius: 28, marginBottom: 6, overflow: 'hidden', backgroundColor: '#eee' },
  userAvatar: { width: '100%', height: '100%' },
  userName: { fontFamily: 'Urbanist-Medium', fontSize: 11, textAlign: 'center' },
  socialSection: { paddingVertical: 15, borderTopWidth: 1 },
  socialScrollContent: { paddingLeft: 16 },
  socialItem: { alignItems: 'center', marginRight: 20, width: 60 },
  socialIconCircle: { width: 52, height: 52, borderRadius: 26, justifyContent: 'center', alignItems: 'center', marginBottom: 6 },
  socialLabel: { fontFamily: 'Urbanist-Medium', fontSize: 10, textAlign: 'center' },
  bottomActions: { flexDirection: 'row', paddingVertical: 15, paddingHorizontal: 16, borderTopWidth: 1, justifyContent: 'space-around', paddingBottom: Platform.OS === 'ios' ? 34 : 15 },
  actionBtn: { alignItems: 'center', flex: 1 },
  actionIconCircle: { width: 52, height: 52, borderRadius: 26, justifyContent: 'center', alignItems: 'center', marginBottom: 6 },
  actionLabel: { fontFamily: 'Urbanist-Medium', fontSize: 11 },
});
