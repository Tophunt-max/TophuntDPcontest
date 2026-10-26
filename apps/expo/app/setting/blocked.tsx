import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  ScrollView,
  TouchableOpacity,
  Image,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useRouter } from 'expo-router';
import { BackButton } from '@/src/components/ui/BackButton';
import { Ionicons } from '@/src/lib/icons';
import { Colors } from '@/constants/theme';
import {
  useBlockedAccounts,
  useUnblockUser,
  useUnhideStoryFrom,
  useUnmuteUser,
  useUnrestrictUser,
} from '@/src/hooks/useProfileData';
import type { BlockedAccount } from '@/src/services/users';
import { emitToast } from '@/src/lib/toastBridge';
import { reportError } from '@/src/lib/reportError';
import { useConfirm } from '@/src/components/modals/ConfirmDialog';

/**
 * Blocked and muted accounts.
 *
 * A block is only usable if it is reversible, and a block made from a profile is
 * hard to undo from that profile: the blocked account no longer appears in
 * search, suggestions or any feed, so there is often no way back to it. This
 * screen is the durable route to the list.
 *
 * It shows only OUTGOING relations. Who has blocked *you* is deliberately not
 * knowable anywhere in the app — the API does not return it.
 */
type Kind = 'block' | 'mute' | 'restrict' | 'storyHide';

/** The undo popup for each list, in the same Logout-style dialog as the profile sheet. */
const UNDO_COPY: Record<Kind, { title: (name: string) => string; message: string; button: string; done: (name: string) => string }> = {
  block: {
    title: (n) => `Unblock ${n}?`,
    message:
      "You'll be able to see each other's battles and stories and message each other again. Follows removed by the block are not restored.",
    button: 'Unblock',
    done: (n) => `Unblocked ${n}.`,
  },
  mute: {
    title: (n) => `Unmute ${n}?`,
    message: 'Their battles and stories will show in your feed again.',
    button: 'Unmute',
    done: (n) => `Unmuted ${n}.`,
  },
  restrict: {
    title: (n) => `Unrestrict ${n}?`,
    message: 'Their new comments on your battles will be visible to everyone again, and you will get notifications from them.',
    button: 'Unrestrict',
    done: (n) => `Unrestricted ${n}.`,
  },
  storyHide: {
    title: (n) => `Show your story to ${n}?`,
    message: 'They will be able to see your stories again.',
    button: 'Show story',
    done: (n) => `${n} can see your stories again.`,
  },
};

export default function BlockedAccountsScreen() {
  const router = useRouter();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const textColor = isDark ? '#fff' : '#212121';
  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;
  const secondary = isDark ? '#A0A0A0' : '#666';
  const border = isDark ? '#35383F' : '#EEEEEE';

  const { data, isLoading, refetch, isRefetching } = useBlockedAccounts();
  const { mutateAsync: unblock } = useUnblockUser();
  const { mutateAsync: unmute } = useUnmuteUser();
  const { mutateAsync: unrestrict } = useUnrestrictUser();
  const { mutateAsync: unhideStory } = useUnhideStoryFrom();
  const [busyUid, setBusyUid] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();

  /** Ask first in the Logout-style dialog, the same as the profile ⋮ sheet. */
  const undoFor: Record<Kind, (uid: string) => Promise<unknown>> = {
    block: unblock,
    mute: unmute,
    restrict: unrestrict,
    storyHide: unhideStory,
  };

  const act = async (uid: string, kind: Kind, username: string | null) => {
    if (busyUid) return;
    const name = `@${username || 'user'}`;
    const copy = UNDO_COPY[kind];
    setBusyUid(uid);
    let failed: any = null;
    try {
      const ok = await confirm({
        title: copy.title(name),
        message: copy.message,
        confirmLabel: copy.button,
        onConfirm: async () => {
          try {
            await undoFor[kind](uid);
          } catch (e) {
            failed = e;
            throw e;
          }
        },
      });
      if (ok) emitToast(copy.done(name), 'success');
      else if (failed) {
        reportError(failed, { screen: 'blocked-accounts', action: `undo-${kind}`, targetUserId: uid });
        emitToast(failed?.message || 'Something went wrong. Please try again.', 'error');
      }
    } finally {
      setBusyUid(null);
    }
  };

  const Row = ({ user, kind }: { user: BlockedAccount; kind: Kind }) => {
    const avatar = user.profileImageUrlThumb || user.profileImageUrl;
    const busy = busyUid === user.uid;
    return (
      <View style={[styles.row, { borderBottomColor: border }]}>
        {avatar ? (
          <Image source={{ uri: avatar }} style={styles.avatar} />
        ) : (
          <View style={[styles.avatar, styles.avatarFallback, { backgroundColor: isDark ? '#1F222A' : '#F0F0F0' }]}>
            <Text style={[styles.avatarInitial, { color: secondary }]}>
              {(user.username || user.fullName || 'U').charAt(0).toUpperCase()}
            </Text>
          </View>
        )}
        <View style={styles.rowText}>
          <Text style={[styles.rowName, { color: textColor }]} numberOfLines={1}>
            {user.fullName || user.username || 'User'}
          </Text>
          <Text style={[styles.rowHandle, { color: secondary }]} numberOfLines={1}>
            @{user.username || 'user'}
          </Text>
        </View>
        <TouchableOpacity
          style={[styles.actionButton, { borderColor: border }]}
          onPress={() => act(user.uid, kind, user.username)}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={`${UNDO_COPY[kind].button} ${user.username || 'user'}`}
        >
          {busy ? (
            <ActivityIndicator size="small" color={textColor} />
          ) : (
            <Text style={[styles.actionText, { color: textColor }]}>{UNDO_COPY[kind].button}</Text>
          )}
        </TouchableOpacity>
      </View>
    );
  };

  const Section = ({
    title,
    hint,
    users,
    kind,
    emptyText,
  }: {
    title: string;
    hint: string;
    users: BlockedAccount[];
    kind: Kind;
    emptyText: string;
  }) => (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: secondary }]}>{title}</Text>
      <Text style={[styles.sectionHint, { color: secondary }]}>{hint}</Text>
      {users.length === 0 ? (
        <Text style={[styles.emptyText, { color: secondary }]}>{emptyText}</Text>
      ) : (
        users.map((u) => <Row key={u.uid} user={u} kind={kind} />)
      )}
    </View>
  );

  const blocked = data?.blocked || [];
  const muted = data?.muted || [];
  const restricted = data?.restricted || [];
  const storyHidden = data?.storyHidden || [];

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]}>
      <View style={styles.header}>
        <BackButton size={24} color={textColor} style={styles.backButton} />
        <Text style={[styles.headerTitle, { color: textColor }]}>Blocked & Muted</Text>
      </View>

      {isLoading && !data ? (
        <View style={styles.center}>
          <ActivityIndicator color="#FF4D67" />
        </View>
      ) : (
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor="#FF4D67" colors={['#FF4D67']} />
          }
        >
          <Section
            title="BLOCKED"
            hint="You and these accounts can't see each other's battles, stories or messages."
            users={blocked}
            kind="block"
            emptyText="You haven't blocked anyone."
          />
          <Section
            title="MUTED"
            hint="Hidden from your feed and stories. They can still follow and message you, and they don't know."
            users={muted}
            kind="mute"
            emptyText="You haven't muted anyone."
          />
          <Section
            title="RESTRICTED"
            hint="Their comments on your battles are visible only to them, and they don't notify you. They don't know."
            users={restricted}
            kind="restrict"
            emptyText="You haven't restricted anyone."
          />
          <Section
            title="STORY HIDDEN FROM"
            hint="These accounts can't see your stories or highlights. They don't know."
            users={storyHidden}
            kind="storyHide"
            emptyText="Your stories are visible to everyone who can normally see them."
          />

          <View style={styles.footerNote}>
            <Ionicons name="information-circle-outline" size={18} color={secondary} />
            <Text style={[styles.footerText, { color: secondary }]}>
              Unblocking someone does not make you follow each other again.
            </Text>
          </View>
        </ScrollView>
      )}
      {dialog}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', height: 56, paddingHorizontal: 16 },
  backButton: { marginRight: 12 },
  headerTitle: { fontSize: 20, fontFamily: 'Urbanist-Bold' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  content: { paddingBottom: 40 },
  section: { paddingTop: 20 },
  sectionTitle: { fontSize: 12, fontFamily: 'Urbanist-Bold', letterSpacing: 1, paddingHorizontal: 20 },
  sectionHint: { fontSize: 12, fontFamily: 'Urbanist-Regular', paddingHorizontal: 20, marginTop: 4, lineHeight: 17 },
  emptyText: { fontSize: 14, fontFamily: 'Urbanist-Medium', paddingHorizontal: 20, paddingVertical: 18 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 12, borderBottomWidth: 1 },
  avatar: { width: 44, height: 44, borderRadius: 22 },
  avatarFallback: { justifyContent: 'center', alignItems: 'center' },
  avatarInitial: { fontSize: 18, fontFamily: 'Urbanist-Bold' },
  rowText: { flex: 1, marginLeft: 12 },
  rowName: { fontSize: 15, fontFamily: 'Urbanist-Bold' },
  rowHandle: { fontSize: 13, fontFamily: 'Urbanist-Regular', marginTop: 2 },
  actionButton: { paddingVertical: 8, paddingHorizontal: 18, borderRadius: 18, borderWidth: 1, minWidth: 88, alignItems: 'center' },
  actionText: { fontSize: 13, fontFamily: 'Urbanist-Bold' },
  footerNote: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingHorizontal: 20, marginTop: 28 },
  footerText: { flex: 1, fontSize: 12, fontFamily: 'Urbanist-Regular', lineHeight: 17 },
});
