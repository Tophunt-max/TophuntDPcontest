import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Platform } from 'react-native';
import { Alert } from '@/src/lib/appAlert';
import { Ionicons } from '@/src/lib/icons';
import { ReanimatedBottomSheet } from '@/src/components/modals/ReanimatedBottomSheet';
import { useBlockUser, useMuteUser, useUnblockUser, useUnmuteUser } from '@/src/hooks/useProfileData';
import { reportUserService } from '@/src/services/users';
import { emitToast } from '@/src/lib/toastBridge';
import { reportError } from '@/src/lib/reportError';

/**
 * Block / Mute / Report for another user's profile.
 *
 * Until this existed, only an admin could block an account and there was no
 * per-user report at all — the only route was the generic "Report a Problem"
 * form in Settings, which raises a support ticket rather than a moderation
 * report. Both app stores require the self-serve version in an app carrying
 * user-generated content.
 *
 * The two actions are deliberately presented differently, because they are not
 * variations of the same thing:
 *
 *   Mute is reversible, invisible and low-stakes, so it applies immediately with
 *   a toast and no confirmation.
 *
 *   Block is mutual, tears down both follow edges and cannot be undone by simply
 *   tapping again, so it asks first and spells out the consequences.
 */

type Props = {
  visible: boolean;
  onClose: () => void;
  targetUserId: string;
  username?: string | null;
  isBlocked?: boolean;
  isMuted?: boolean;
  isDark?: boolean;
};

/** Confirm on every platform — Alert.alert is a no-op on web. */
function confirmDestructive(title: string, message: string, confirmLabel: string): Promise<boolean> {
  if (Platform.OS === 'web') {
    if (typeof window === 'undefined') return Promise.resolve(false);
    // eslint-disable-next-line no-alert
    return Promise.resolve(window.confirm(`${title}\n\n${message}`));
  }
  return new Promise((resolve) => {
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: confirmLabel, style: 'destructive', onPress: () => resolve(true) },
    ]);
  });
}

export const UserActionsSheet: React.FC<Props> = ({
  visible,
  onClose,
  targetUserId,
  username,
  isBlocked = false,
  isMuted = false,
  isDark = false,
}) => {
  const [busy, setBusy] = useState<string | null>(null);

  const { mutateAsync: block } = useBlockUser();
  const { mutateAsync: unblock } = useUnblockUser();
  const { mutateAsync: mute } = useMuteUser();
  const { mutateAsync: unmute } = useUnmuteUser();

  const textColor = isDark ? '#FFFFFF' : '#212121';
  const secondary = isDark ? '#A0A0A0' : '#666';
  const name = username ? `@${username}` : 'this user';

  /** Run an action, report failure, and close only on success. */
  const run = async (key: string, action: () => Promise<unknown>, successMessage: string) => {
    if (busy) return;
    setBusy(key);
    try {
      await action();
      emitToast(successMessage, 'success');
      onClose();
    } catch (e: any) {
      reportError(e, { screen: 'user-actions', action: key, targetUserId });
      emitToast(e?.message || 'Something went wrong. Please try again.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const handleMute = () =>
    isMuted
      ? run('mute', () => unmute(targetUserId), `Unmuted ${name}.`)
      : run('mute', () => mute(targetUserId), `Muted ${name}. You won't see their posts in your feed.`);

  const handleBlock = async () => {
    if (isBlocked) {
      await run('block', () => unblock(targetUserId), `Unblocked ${name}.`);
      return;
    }
    const ok = await confirmDestructive(
      `Block ${name}?`,
      "You won't see each other's battles, stories or messages, and you'll both stop following each other. " +
        "They won't be told you blocked them.",
      'Block',
    );
    if (!ok) return;
    await run('block', () => block(targetUserId), `Blocked ${name}.`);
  };

  const handleReport = async () => {
    const ok = await confirmDestructive(
      `Report ${name}?`,
      'Our moderation team will review this account. Reporting is anonymous.',
      'Report',
    );
    if (!ok) return;
    await run('report', () => reportUserService(targetUserId, 'Reported from profile'), 'Thanks — our team will review this account.');
  };

  const Row = ({
    icon,
    label,
    hint,
    onPress,
    danger,
    loading,
  }: {
    icon: any;
    label: string;
    hint?: string;
    onPress: () => void;
    danger?: boolean;
    loading?: boolean;
  }) => (
    <TouchableOpacity
      style={styles.row}
      onPress={onPress}
      disabled={!!busy}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
    >
      <View style={styles.rowIcon}>
        {loading ? (
          <ActivityIndicator size="small" color={danger ? '#FF4D67' : textColor} />
        ) : (
          <Ionicons name={icon} size={22} color={danger ? '#FF4D67' : textColor} />
        )}
      </View>
      <View style={styles.rowText}>
        <Text style={[styles.rowLabel, { color: danger ? '#FF4D67' : textColor }]}>{label}</Text>
        {hint ? <Text style={[styles.rowHint, { color: secondary }]}>{hint}</Text> : null}
      </View>
    </TouchableOpacity>
  );

  return (
    <ReanimatedBottomSheet visible={visible} onClose={onClose} maxHeight={360}>
      <View style={styles.container}>
        <Row
          icon={isMuted ? 'volume-high-outline' : 'volume-mute-outline'}
          label={isMuted ? 'Unmute' : 'Mute'}
          hint={
            isMuted
              ? 'Show their battles and stories in your feed again'
              : "Hide their battles and stories from your feed. They won't know."
          }
          onPress={handleMute}
          loading={busy === 'mute'}
        />
        <Row
          icon="flag-outline"
          label="Report"
          hint="Send this account to our moderation team"
          onPress={handleReport}
          loading={busy === 'report'}
        />
        <Row
          icon={isBlocked ? 'lock-open-outline' : 'ban-outline'}
          label={isBlocked ? 'Unblock' : 'Block'}
          hint={
            isBlocked
              ? 'You will be able to see and message each other again'
              : "You'll both disappear from each other's app"
          }
          onPress={handleBlock}
          danger={!isBlocked}
          loading={busy === 'block'}
        />
      </View>
    </ReanimatedBottomSheet>
  );
};

const styles = StyleSheet.create({
  container: { paddingBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 16 },
  rowIcon: { width: 34, alignItems: 'center' },
  rowText: { flex: 1, marginLeft: 8 },
  rowLabel: { fontFamily: 'Urbanist-Bold', fontSize: 16 },
  rowHint: { fontFamily: 'Urbanist-Regular', fontSize: 12, marginTop: 2, lineHeight: 16 },
});

export default UserActionsSheet;
