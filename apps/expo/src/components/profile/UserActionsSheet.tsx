import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { Ionicons } from '@/src/lib/icons';
import { ReanimatedBottomSheet } from '@/src/components/modals/ReanimatedBottomSheet';
import { useConfirm, type ConfirmOptions } from '@/src/components/modals/ConfirmDialog';
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
 * Every row (Mute, Unmute, Report, Block, Unblock) asks first in the same themed
 * `ConfirmDialog` as Logout, identical on native and web. The dialog stays open
 * with a spinner while the request runs, so the action cannot be sent twice, and
 * it spells out what will happen. Block and Report get the red (destructive)
 * button; the reversible Mute / Unmute / Unblock get the brand-pink one.
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

type ActionKey = 'mute' | 'report' | 'block';

export const UserActionsSheet: React.FC<Props> = ({
  visible,
  onClose,
  targetUserId,
  username,
  isBlocked = false,
  isMuted = false,
  isDark = false,
}) => {
  const [busy, setBusy] = useState<ActionKey | null>(null);
  const { confirm, dialog } = useConfirm();

  const { mutateAsync: block } = useBlockUser();
  const { mutateAsync: unblock } = useUnblockUser();
  const { mutateAsync: mute } = useMuteUser();
  const { mutateAsync: unmute } = useUnmuteUser();

  const textColor = isDark ? '#FFFFFF' : '#212121';
  const secondary = isDark ? '#A0A0A0' : '#666';
  const name = username ? `@${username}` : 'this user';

  /**
   * Ask in the Logout-style dialog, then run the action inside it (spinner on the
   * confirm button). Success: toast + close the sheet. Failure: the dialog
   * closes, the sheet stays open, and the error is shown and reported.
   */
  const ask = async (
    key: ActionKey,
    opts: Omit<ConfirmOptions, 'onConfirm'>,
    action: () => Promise<unknown>,
    successMessage: string,
  ) => {
    if (busy) return;
    setBusy(key);
    let failed: any = null;
    try {
      const ok = await confirm({
        ...opts,
        onConfirm: async () => {
          try {
            await action();
          } catch (e) {
            failed = e;
            throw e;
          }
        },
      });
      if (ok) {
        emitToast(successMessage, 'success');
        onClose();
      } else if (failed) {
        reportError(failed, { screen: 'user-actions', action: key, targetUserId });
        emitToast(failed?.message || 'Something went wrong. Please try again.', 'error');
      }
    } finally {
      setBusy(null);
    }
  };

  const handleMute = () =>
    isMuted
      ? ask(
          'mute',
          {
            title: `Unmute ${name}?`,
            message: 'Their battles and stories will show in your feed again.',
            confirmLabel: 'Unmute',
          },
          () => unmute(targetUserId),
          `Unmuted ${name}.`,
        )
      : ask(
          'mute',
          {
            title: `Mute ${name}?`,
            message:
              "You won't see their battles and stories in your feed. They won't be told, and you can unmute any time from their profile or Settings > Blocked accounts.",
            confirmLabel: 'Mute',
          },
          () => mute(targetUserId),
          `Muted ${name}. You won't see their posts in your feed.`,
        );

  const handleBlock = () =>
    isBlocked
      ? ask(
          'block',
          {
            title: `Unblock ${name}?`,
            message:
              "You'll be able to see each other's battles and stories and message each other again. Follows removed by the block are not restored.",
            confirmLabel: 'Unblock',
          },
          () => unblock(targetUserId),
          `Unblocked ${name}.`,
        )
      : ask(
          'block',
          {
            title: `Block ${name}?`,
            message:
              "You won't see each other's battles, stories or messages, and you'll both stop following each other. They won't be told you blocked them.",
            confirmLabel: 'Block',
            destructive: true,
          },
          () => block(targetUserId),
          `Blocked ${name}.`,
        );

  const handleReport = () =>
    ask(
      'report',
      {
        title: `Report ${name}?`,
        message: 'Our moderation team will review this account. Reporting is anonymous: they will not know it was you.',
        confirmLabel: 'Report',
        destructive: true,
      },
      () => reportUserService(targetUserId, 'Reported from profile'),
      'Thanks — our team will review this account.',
    );

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
    <>
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
      {/* A Modal, so it draws above the sheet's Portal on native and web. */}
      {dialog}
    </>
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
