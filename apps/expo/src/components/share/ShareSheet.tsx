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
import { Ionicons } from '@/src/lib/icons';
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
import { startChat, sendMessage } from '@/src/services/messages/messageService';
import { useToast } from '../toast/ToastProvider';
import {
  battleUrl,
  battleCaption,
  platformShareUrl,
  openShareUrl,
  shareBattle,
  downloadBattleImage,
  copyBattleLink,
  type ShareMatchLike,
} from '@/src/lib/share';

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
  /** The battle, if the caller already has it — avoids a fetch and gives the
   *  freshest handles/title. The composite image (`vsImageUrl`) is still fetched
   *  on open since a feed item may not carry it yet. */
  match?: ShareMatchLike;
}

export const ShareSheet = ({ visible, onDismiss, isDark, matchId, match: matchProp }: ShareSheetProps) => {
  const translateY = useSharedValue(SHEET_HEIGHT);
  const opacity = useSharedValue(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [users, setUsers] = useState<any[]>([]);
  const [match, setMatch] = useState<ShareMatchLike | null>(matchProp ?? null);
  const [busy, setBusy] = useState(false);
  const { addToast } = useToast();

  const backgroundColor = isDark ? '#1F222A' : '#FFFFFF';
  const textColor = isDark ? '#FFFFFF' : '#212121';
  const subTextColor = isDark ? '#BDBDBD' : '#616161';
  const inputBg = isDark ? '#1F222A' : '#F5F5F5';
  const borderColor = isDark ? '#35383F' : '#EEEEEE';

  const url = battleUrl(matchId);
  const caption = battleCaption(match ?? {}, url);
  const vsImageUrl = match?.vsImageUrl ?? null;

  useEffect(() => {
    if (visible) {
      translateY.value = withSpring(0, { damping: 20, stiffness: 90 });
      opacity.value = withTiming(1, { duration: 300 });
      loadUsers();
      // Pull the match detail so we have the composite VS image + latest handles.
      let alive = true;
      (async () => {
        try {
          const detail = await contestService.getMatchById(matchId);
          if (alive && detail) setMatch(detail as ShareMatchLike);
        } catch {
          /* keep whatever the caller passed */
        }
      })();
      return () => { alive = false; };
    }
    translateY.value = withSpring(SHEET_HEIGHT);
    opacity.value = withTiming(0, { duration: 300 });
  }, [visible, matchId]);

  const loadUsers = async () => {
    try {
      setUsers(await fetchSuggestedUsers());
    } catch (e) {
      console.error(e);
    }
  };

  /** Best-effort share-count bump; never blocks the UX. */
  const bumpShare = () => {
    contestService.shareMatch(matchId).catch((e) => console.warn('[share] count bump failed', e));
  };

  const closeSheet = useCallback(() => {
    translateY.value = withSpring(SHEET_HEIGHT, { damping: 20, stiffness: 90 }, (finished) => {
      if (finished) runOnJS(onDismiss)();
    });
    opacity.value = withTiming(0, { duration: 300 });
  }, [onDismiss]);

  /** Open the OS share sheet with the VS image + caption (platform-appropriate). */
  const doOSShare = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const outcome = await shareBattle({ vsImageUrl, caption, url });
      if (outcome === 'shared' || outcome === 'copied') {
        bumpShare();
        addToast(outcome === 'copied' ? 'Copied — paste to share' : 'Shared!', 'success');
        closeSheet();
      } else if (outcome === 'failed') {
        addToast('Could not open the share sheet. Try “Copy link”.', 'error');
      }
      // 'dismissed' → user backed out, stay silent.
    } finally {
      setBusy(false);
    }
  }, [busy, vsImageUrl, caption, url, closeSheet]);

  /** A specific app: use its prefilled web/app intent, else fall back to the OS sheet. */
  const onPlatform = useCallback(async (platformId: string) => {
    const intent = platformShareUrl(platformId, caption, url);
    if (intent) {
      const ok = await openShareUrl(intent);
      if (ok) {
        bumpShare();
        closeSheet();
        return;
      }
    }
    await doOSShare();
  }, [caption, url, doOSShare, closeSheet]);

  /** Send the battle straight into a DM with the tapped user. */
  const onSendToUser = useCallback(async (u: any) => {
    if (busy) return;
    setBusy(true);
    try {
      const chatId = await startChat(u.id, { displayName: u.name, photoURL: u.avatar });
      await sendMessage(chatId, caption);
      bumpShare();
      addToast(`Sent to ${String(u.name || 'user').split(' ')[0]}`, 'success');
      closeSheet();
    } catch (e: any) {
      addToast(e?.message || 'Could not send the message.', 'error');
    } finally {
      setBusy(false);
    }
  }, [busy, caption, closeSheet]);

  const onCopyLink = useCallback(async () => {
    await copyBattleLink(url);
    bumpShare();
    addToast('Link copied to clipboard!', 'success');
    closeSheet();
  }, [url, closeSheet]);

  const onDownload = useCallback(async () => {
    if (!vsImageUrl) {
      addToast('The VS image isn’t ready yet — open the battle story once to generate it.', 'info');
      return;
    }
    const ok = await downloadBattleImage(vsImageUrl);
    addToast(
      ok ? (Platform.OS === 'web' ? 'Image downloaded' : 'Choose “Save image”') : 'Could not save the image.',
      ok ? 'success' : 'error',
    );
  }, [vsImageUrl]);

  const gesture = Gesture.Pan()
    .onUpdate((event) => {
      if (event.translationY > 0) translateY.value = event.translationY;
    })
    .onEnd((event) => {
      if (event.translationY > 150 || event.velocityY > 500) runOnJS(closeSheet)();
      else translateY.value = withSpring(0, { damping: 20, stiffness: 90 });
    });

  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ translateY: translateY.value }] }));
  const backdropStyle = useAnimatedStyle(() => ({
    opacity: interpolate(translateY.value, [0, SHEET_HEIGHT], [0.5, 0], Extrapolation.CLAMP),
  }));

  // Parent flips `visible` to false only AFTER the close animation finishes (see
  // closeSheet → onDismiss), so gating on `visible` keeps the slide-out visible
  // and avoids reading a shared value during render.
  if (!visible) return null;

  const q = searchQuery.trim().toLowerCase();
  const filteredUsers = users.filter((u) =>
    !q || String(u.name || '').toLowerCase().includes(q) || String(u.username || '').toLowerCase().includes(q),
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
                  placeholder="Search people to send to"
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
                        <TouchableOpacity key={user.id} style={styles.userItem} onPress={() => onSendToUser(user)} disabled={busy}>
                            <View style={styles.userAvatarWrapper}>
                                {user.avatar ? (
                                  <Image source={{ uri: user.avatar }} style={styles.userAvatar} />
                                ) : (
                                  <View style={[styles.userAvatar, styles.avatarFallback]}>
                                    <Text style={styles.avatarInitial}>{String(user.name || 'U').charAt(0).toUpperCase()}</Text>
                                  </View>
                                )}
                            </View>
                            <Text style={[styles.userName, { color: textColor }]} numberOfLines={1}>{String(user.name || 'User').split(' ')[0]}</Text>
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
                            <TouchableOpacity key={platform.id} style={styles.socialItem} onPress={() => onPlatform(platform.id)} disabled={busy}>
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
                <TouchableOpacity style={styles.actionBtn} onPress={onCopyLink} disabled={busy}>
                    <View style={[styles.actionIconCircle, { backgroundColor: isDark ? '#2A2E38' : '#F5F5F5' }]}>
                        <Icons.Link_Icon width={28} height={28} color={textColor} />
                    </View>
                    <Text style={[styles.actionLabel, { color: textColor }]}>Copy link</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.actionBtn} onPress={doOSShare} disabled={busy}>
                    <View style={[styles.actionIconCircle, { backgroundColor: isDark ? '#2A2E38' : '#F5F5F5' }]}>
                        <Icons.Share_Icon width={28} height={28} color={textColor} />
                    </View>
                    <Text style={[styles.actionLabel, { color: textColor }]}>Share to...</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.actionBtn} onPress={onDownload} disabled={busy}>
                    <View style={[styles.actionIconCircle, { backgroundColor: isDark ? '#2A2E38' : '#F5F5F5' }]}>
                        <Icons.Download_Icon width={28} height={28} color={textColor} />
                    </View>
                    <Text style={[styles.actionLabel, { color: textColor }]}>Save image</Text>
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
  avatarFallback: { backgroundColor: '#7C3AED', alignItems: 'center', justifyContent: 'center' },
  avatarInitial: { color: '#fff', fontFamily: 'Urbanist-Bold', fontSize: 22 },
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
