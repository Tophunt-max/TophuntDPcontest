import React, { useEffect, useState, useCallback, useMemo } from 'react';
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
  ActivityIndicator,
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
  shareImageFile,
  shareBattleLink,
  downloadBattleImage,
  copyBattleLink,
  canShareFilesOnWeb,
  isCompletedShare,
  prepareShareFile,
  type ShareMatchLike,
  type ShareOutcome,
} from '@/src/lib/share';
import { useBattleShareAsset } from '@/src/hooks/useBattleShareAsset';
import { useAuthGate } from '@/src/hooks/useAuthGate';
import { auth } from '@/src/services/firebase/initFirebase';
import { createShareCounter, platformShareMode, shareOutcomeMessage } from '@/src/lib/vsShareAsset';

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
  /** The battle, if the caller already has it — gives handles/title for the
   *  caption immediately. The IMAGE is never taken from here: it is always
   *  resolved for `matchId` via the server (see src/lib/vsShareAsset.ts). */
  match?: ShareMatchLike;
}

/**
 * The battle share sheet (feed cards and anywhere else that shares a match).
 *
 * Every image-capable action — "Share to…", WhatsApp / Messenger / Instagram /
 * Telegram / Snapchat, and Save image — uses the ONE canonical VS image resolved
 * by `useBattleShareAsset`. X and Facebook intents, Copy link and DMs are
 * link-only by nature and are labelled that way. Nothing here ever shares a
 * single participant's photo, and the share count is bumped at most once per
 * opening, only for a completed share.
 */

export const ShareSheet = ({ visible, onDismiss, isDark, matchId, match: matchProp }: ShareSheetProps) => {
  const translateY = useSharedValue(SHEET_HEIGHT);
  const opacity = useSharedValue(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [users, setUsers] = useState<any[]>([]);
  const [match, setMatch] = useState<ShareMatchLike | null>(matchProp ?? null);
  const [busy, setBusy] = useState(false);
  const { addToast } = useToast();
  const { asset, loading: assetLoading, retry: retryAsset } = useBattleShareAsset(matchId, visible);
  const assetStatus = asset?.status ?? 'loading';
  const imageUrl = asset?.status === 'ready' && asset.source.kind === 'remote' ? asset.source.url : null;
  const isWeb = Platform.OS === 'web';
  const webFiles = isWeb && visible ? canShareFilesOnWeb() : false;
  // Web: fetch the image into a File as soon as it is known, so the tap calls
  // navigator.share with no network wait (Safari drops the gesture otherwise).
  const [prepared, setPrepared] = useState<{ url: string; file: File } | null>(null);
  useEffect(() => {
    if (!isWeb || !webFiles || !imageUrl) return;
    let alive = true;
    void prepareShareFile({ kind: 'remote', url: imageUrl }).then((file) => {
      if (alive && file) setPrepared({ url: imageUrl, file });
    });
    return () => {
      alive = false;
    };
  }, [isWeb, webFiles, imageUrl]);
  const preparedFile = prepared && prepared.url === imageUrl ? prepared.file : null;
  // The share count is an authenticated action; a guest's share is real but not
  // recorded (it would only 401).
  const counter = useMemo(
    () => createShareCounter(() => (auth.currentUser ? contestService.shareMatch(matchId) : Promise.resolve())),
    [matchId],
  );
  const { requireAuth } = useAuthGate();
  // One counted share per OPENING of the sheet.
  useEffect(() => {
    if (visible) counter.reset();
  }, [visible, counter]);

  const backgroundColor = isDark ? '#1F222A' : '#FFFFFF';
  const textColor = isDark ? '#FFFFFF' : '#212121';
  const subTextColor = isDark ? '#BDBDBD' : '#616161';
  const inputBg = isDark ? '#1F222A' : '#F5F5F5';
  const borderColor = isDark ? '#35383F' : '#EEEEEE';

  const url = battleUrl(matchId);
  const caption = battleCaption(match ?? {}, url);

  // The caption data must follow the SELECTED match, never a previous one.
  useEffect(() => {
    setMatch(matchProp && (!matchProp.id || matchProp.id === matchId) ? matchProp : null);
  }, [matchId, matchProp]);

  useEffect(() => {
    if (visible) {
      translateY.value = withSpring(0, { damping: 20, stiffness: 90 });
      opacity.value = withTiming(1, { duration: 300 });
      loadUsers();
      // Latest handles/title for the caption. (The image comes from
      // useBattleShareAsset, not from this payload.)
      let alive = true;
      (async () => {
        try {
          const detail: any = await contestService.getMatchById(matchId);
          if (alive && detail && (!detail.id || detail.id === matchId)) setMatch(detail as ShareMatchLike);
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

  /** Report an outcome truthfully, count it at most once, close on success. */
  const finish = useCallback((outcome: ShareOutcome | 'intent_opened') => {
    counter.record(outcome);
    const msg = shareOutcomeMessage(outcome);
    if (msg) addToast(msg.text, msg.tone);
    return outcome === 'intent_opened' || isCompletedShare(outcome as ShareOutcome);
  }, [counter, addToast]);

  const notReadyToast = useCallback(() => {
    if (assetStatus === 'preparing' || assetStatus === 'loading') {
      addToast('The VS image is still being prepared — try again in a moment.', 'info');
    } else if (assetStatus === 'waiting_for_opponent') {
      addToast('This battle is waiting for an opponent, so there is no VS image yet.', 'info');
    } else {
      addToast('The VS image isn’t available for this battle.', 'info');
    }
  }, [assetStatus, addToast]);

  const closeSheet = useCallback(() => {
    translateY.value = withSpring(SHEET_HEIGHT, { damping: 20, stiffness: 90 }, (finished) => {
      if (finished) runOnJS(onDismiss)();
    });
    opacity.value = withTiming(0, { duration: 300 });
  }, [onDismiss]);

  /**
   * "Share to…": the VS image when it exists. If the battle has no VS image
   * (waiting, unavailable) it shares the link and says so. While the image is
   * still being prepared it waits rather than quietly sending a link.
   */
  const doOSShare = useCallback(async () => {
    if (busy) return;
    if (assetStatus === 'preparing' || assetStatus === 'loading') return notReadyToast();
    setBusy(true);
    try {
      const outcome = imageUrl
        ? await shareImageFile({ source: { kind: 'remote', url: imageUrl }, caption, url, file: preparedFile })
        : await shareBattleLink({ caption, url });
      if (finish(outcome)) closeSheet();
    } finally {
      setBusy(false);
    }
  }, [busy, assetStatus, imageUrl, preparedFile, caption, url, finish, closeSheet, notReadyToast]);

  /** A specific app — routed by what that app can actually receive. */
  const onPlatform = useCallback(async (platformId: string) => {
    if (busy) return;
    const mode = platformShareMode(platformId, { isWeb, assetStatus, webCanShareFiles: webFiles });
    if (mode === 'wait') return notReadyToast();
    if (mode === 'image_sheet' && imageUrl) {
      setBusy(true);
      try {
        const outcome = await shareImageFile({ source: { kind: 'remote', url: imageUrl }, caption, url, file: preparedFile });
        if (finish(outcome)) closeSheet();
      } finally {
        setBusy(false);
      }
      return;
    }
    if (mode === 'link_intent') {
      const intent = platformShareUrl(platformId, caption, url);
      if (intent && (await openShareUrl(intent))) {
        finish('intent_opened');
        closeSheet();
        return;
      }
    }
    setBusy(true);
    try {
      if (finish(await shareBattleLink({ caption, url }))) closeSheet();
    } finally {
      setBusy(false);
    }
  }, [busy, isWeb, assetStatus, webFiles, imageUrl, preparedFile, caption, url, finish, closeSheet, notReadyToast]);

  /** Send the battle straight into a DM with the tapped user (caption + link). */
  const onSendToUser = useCallback(async (u: any) => {
    if (busy) return;
    if (!requireAuth('message', { beforeNavigate: closeSheet })) return;
    setBusy(true);
    try {
      const chatId = await startChat(u.id, { displayName: u.name, photoURL: u.avatar });
      await sendMessage(chatId, caption);
      counter.record('dm_sent');
      addToast(`Battle link sent to ${String(u.name || 'user').split(' ')[0]}`, 'success');
      closeSheet();
    } catch (e: any) {
      addToast(e?.message || 'Could not send the message.', 'error');
    } finally {
      setBusy(false);
    }
  }, [busy, caption, closeSheet, counter, addToast, requireAuth]);

  /** URL only, by design. Counted once per opening however often it is tapped. */
  const onCopyLink = useCallback(async () => {
    await copyBattleLink(url);
    counter.record('copied_link');
    addToast('Link copied to clipboard!', 'success');
    closeSheet();
  }, [url, closeSheet, counter, addToast]);

  /** Saves exactly the image that sharing attaches. Not a share; never counted. */
  const onDownload = useCallback(async () => {
    if (!imageUrl) return notReadyToast();
    const ok = await downloadBattleImage(imageUrl);
    addToast(
      ok ? (isWeb ? 'VS image downloaded' : 'Choose “Save image”') : 'Could not save the image.',
      ok ? 'success' : 'error',
    );
  }, [imageUrl, isWeb, notReadyToast, addToast]);

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

            {/* What will actually be shared — stated, not implied. */}
            <View style={[styles.previewRow, { borderColor }]}>
              {imageUrl ? (
                <Image source={{ uri: imageUrl }} style={styles.previewImage} accessibilityLabel="VS battle image" />
              ) : (
                <View style={[styles.previewImage, styles.previewPlaceholder, { backgroundColor: inputBg }]}>
                  {assetLoading || assetStatus === 'preparing' ? <ActivityIndicator color="#FF4D67" /> : <Ionicons name="share-social" size={22} color={subTextColor} />}
                </View>
              )}
              <View style={{ flex: 1 }}>
                <Text style={[styles.previewTitle, { color: textColor }]}>
                  {imageUrl
                    ? 'VS image ready'
                    : assetStatus === 'preparing' || assetLoading
                      ? 'Preparing the VS image…'
                      : assetStatus === 'waiting_for_opponent'
                        ? 'Waiting for an opponent'
                        : 'VS image unavailable'}
                </Text>
                <Text style={[styles.previewSub, { color: subTextColor }]}>
                  {imageUrl
                    ? 'Both photos with the VS badge, plus the battle link.'
                    : assetStatus === 'preparing' || assetLoading
                      ? 'Image shares will be available in a moment.'
                      : 'Sharing will send the battle link only.'}
                </Text>
              </View>
              {!imageUrl && !assetLoading && assetStatus === 'preparing' ? (
                <TouchableOpacity onPress={retryAsset} accessibilityRole="button" style={styles.previewRetry}>
                  <Text style={styles.previewRetryText}>Retry</Text>
                </TouchableOpacity>
              ) : null}
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
                    <Text style={[styles.actionLabel, { color: textColor }]}>{imageUrl ? 'Share image' : 'Share link'}</Text>
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
  previewRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: 16, marginBottom: 12, padding: 10, borderWidth: 1, borderRadius: 14 },
  previewImage: { width: 45, height: 80, borderRadius: 8 },
  previewPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  previewTitle: { fontFamily: 'Urbanist-Bold', fontSize: 14 },
  previewSub: { fontFamily: 'Urbanist-Regular', fontSize: 12, marginTop: 2 },
  previewRetry: { paddingHorizontal: 10, paddingVertical: 6 },
  previewRetryText: { color: '#FF4D67', fontFamily: 'Urbanist-Bold', fontSize: 13 },
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
