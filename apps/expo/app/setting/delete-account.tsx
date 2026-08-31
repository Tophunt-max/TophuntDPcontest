import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  ScrollView,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
  Share,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useRouter } from 'expo-router';
import { BackButton } from '@/src/components/ui/BackButton';
import { Colors } from '@/constants/theme';
import { callApi } from '@/src/services/api';
import { signOut } from '@/src/services/auth';
import { emitToast } from '@/src/lib/toastBridge';
import { reportError } from '@/src/lib/reportError';
import { Ionicons } from '@/src/lib/icons';
import { useConfirm } from '@/src/components/modals/ConfirmDialog';

/**
 * Delete account.
 *
 * Both app stores require an in-app deletion path. This screen used to have two
 * ways of showing the user nothing at all, and both of them fired in the cases
 * that matter most:
 *
 *  1. The delete button was rendered only when the server said `deletable`. A
 *     pending payout or a live contest made that false, so the screen explained
 *     the problem and then offered no way forward. Deletion is now always
 *     available — what varies is WHEN it runs — so there is no state in which
 *     this screen has no primary action.
 *  2. If the eligibility call failed for any reason, the screen rendered a bare
 *     line of error text and skipped its entire body. The most common cause was a
 *     403 for a blocked account, i.e. exactly the person most likely to be trying
 *     to leave. A failed status check is now recoverable (retry) and never hides
 *     the deletion path.
 *
 * The flow is deliberately explicit rather than a single tap: say what happens,
 * offer the data export first, require the word DELETE, then confirm the moment.
 */

interface Deferral {
  code: string;
  message: string;
}

interface DeletionWarning {
  code: string;
  message: string;
}

interface ExistingRequest {
  status: 'pending' | 'processing' | 'completed' | 'cancelled';
  reason: string | null;
  requestedAt: number;
  scheduledFor: number;
  deferredReason: string | null;
  balanceAtRequest: number;
}

interface Eligibility {
  deletable?: boolean;
  /** Older field name; the server still sends it as an alias for `deferrals`. */
  blockers?: Deferral[];
  deferrals?: Deferral[];
  warnings?: DeletionWarning[];
  balance?: number;
  gracePeriodDays?: number;
  wouldPurgeAt?: number;
  request?: ExistingRequest | null;
}

const CONFIRM_WORD = 'DELETE';

const formatDate = (ms?: number | null): string => {
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  } catch {
    return new Date(ms).toDateString();
  }
};

export default function DeleteAccountScreen() {
  const router = useRouter();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const textColor = isDark ? '#fff' : '#212121';
  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;
  const secondary = isDark ? '#A0A0A0' : '#666';
  const inputBg = isDark ? '#1F222A' : '#FAFAFA';
  const border = isDark ? '#35383F' : '#EEEEEE';

  const [loading, setLoading] = useState(true);
  const [eligibility, setEligibility] = useState<Eligibility | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await callApi('accountDeletionStatus');
      setEligibility(res);
    } catch (e: any) {
      setLoadError(e?.message || 'Could not check your account status.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const { confirm, dialog: confirmDialog } = useConfirm();

  // `blockers` is the old name for the same list. Read both so this screen works
  // against a server that predates the rename.
  const deferrals = eligibility?.deferrals ?? eligibility?.blockers ?? [];
  const pending = eligibility?.request ?? null;
  const graceDays = eligibility?.gracePeriodDays ?? 30;
  const balance = eligibility?.balance ?? 0;
  const confirmed = confirmText.trim().toUpperCase() === CONFIRM_WORD;
  const canSubmit = confirmed && !submitting;

  /**
   * Download everything we hold about the account, before erasing it.
   *
   * Offered above the confirmation rather than below it: after the request the
   * account is out of service, and this is the last comfortable moment to take a
   * copy. On web this is a real file download. On native there is no filesystem
   * module in this app, so the JSON goes through the share sheet, with the
   * clipboard as the fallback — both keep the data on the user's device without
   * adding a native dependency to the build.
   */
  const exportData = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const bundle = await callApi('exportMyData');
      const json = JSON.stringify(bundle, null, 2);

      if (Platform.OS === 'web') {
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `tophunt-my-data-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
        emitToast('Your data has been downloaded.', 'success');
      } else {
        try {
          await Share.share({ message: json, title: 'My TopHunt data' });
        } catch {
          await Clipboard.setStringAsync(json);
          emitToast('Your data was copied to the clipboard.', 'success');
        }
      }
    } catch (e: any) {
      reportError(e, { screen: 'delete-account', step: 'export' });
      emitToast(e?.message || 'Could not export your data. Please try again.', 'error');
    } finally {
      setExporting(false);
    }
  };

  const submitRequest = async () => {
    setSubmitting(true);
    try {
      const res = await callApi('requestAccountDeletion', {
        confirm: true,
        reason: reason.trim() || undefined,
      });
      // The account is out of service from here on. Sign out WITHOUT the
      // authenticated push-token detach: that call cannot succeed now, and its
      // failure would surface as "Your session expired" on top of this success.
      await signOut({ skipPushTokenUnregister: true }).catch(() => {});
      const when = formatDate(res?.scheduledFor);
      emitToast(
        when
          ? `Your account is scheduled for deletion on ${when}.`
          : 'Your account is scheduled for deletion.',
        'success',
      );
      router.replace('/auth/login');
    } catch (e: any) {
      reportError(e, { screen: 'delete-account' });
      emitToast(e?.message || 'Could not delete your account. Please try again.', 'error');
      setSubmitting(false);
      // Rethrow so the confirmation dialog closes instead of spinning forever.
      throw e;
    }
  };

  const askThenSubmit = () => {
    if (!canSubmit) return;
    const when = formatDate(eligibility?.wouldPurgeAt);
    void confirm({
      title: 'Delete your account?',
      message:
        graceDays > 0
          ? `Your account will be closed now and permanently erased on ${when}. You can sign in before then to cancel. Your remaining coins are forfeited.`
          : 'This is permanent. Your profile, entries, stories and remaining coin balance are removed and cannot be restored.',
      confirmLabel: 'Delete my account',
      cancelLabel: 'Keep my account',
      destructive: true,
      onConfirm: submitRequest,
    });
  };

  const cancelDeletion = async () => {
    setSubmitting(true);
    try {
      await callApi('cancelAccountDeletion');
      emitToast('Your account is no longer scheduled for deletion.', 'success');
      await load();
    } catch (e: any) {
      reportError(e, { screen: 'delete-account', step: 'cancel' });
      emitToast(e?.message || 'Could not cancel the deletion. Please try again.', 'error');
      throw e;
    } finally {
      setSubmitting(false);
    }
  };

  const askThenCancel = () => {
    void confirm({
      title: 'Keep your account?',
      message: 'Your account will be restored and the scheduled deletion cancelled.',
      confirmLabel: 'Keep my account',
      cancelLabel: 'Continue deleting',
      onConfirm: cancelDeletion,
    });
  };

  const renderBody = () => {
    /**
     * A failed status check must never hide the deletion path.
     *
     * This branch used to be the whole screen: one line of error text, no button,
     * no retry. The usual cause was a 403 on a blocked account — the person with
     * the most reason to be here. The status call only decides what to WARN
     * about, so its failure degrades to a retry plus an honest note, and the
     * request below stays available.
     */
    if (loadError) {
      return (
        <>
          <View style={[styles.blockerBox, { backgroundColor: inputBg, borderColor: border }]}>
            <Text style={[styles.sectionTitle, { color: textColor }]}>
              We couldn&apos;t check your account details
            </Text>
            <Text style={[styles.body, { color: secondary }]}>{loadError}</Text>
            <Text style={[styles.body, { color: secondary, marginTop: 8 }]}>
              You can still request deletion below — we will confirm the details on our side.
            </Text>
            <TouchableOpacity
              onPress={() => void load()}
              style={[styles.secondaryBtn, { borderColor: border }]}
              accessibilityRole="button"
              accessibilityLabel="Try checking your account details again"
            >
              <Ionicons name="refresh-outline" size={18} color={textColor} />
              <Text style={[styles.secondaryBtnText, { color: textColor }]}>Try again</Text>
            </TouchableOpacity>
          </View>
          {renderRequestForm()}
        </>
      );
    }

    // Already scheduled: this screen becomes the way back.
    if (pending) {
      const when = formatDate(pending.scheduledFor);
      const isProcessing = pending.status === 'processing';
      return (
        <>
          <View style={[styles.blockerBox, { backgroundColor: inputBg, borderColor: '#FF4D67' }]}>
            <Text style={[styles.sectionTitle, { color: textColor }]}>
              {isProcessing
                ? 'Your account is being deleted'
                : `Scheduled for deletion${when ? ` on ${when}` : ''}`}
            </Text>
            <Text style={[styles.body, { color: secondary }]}>
              {isProcessing
                ? 'Deletion has started and can no longer be cancelled.'
                : 'Your account is closed and hidden from other people. Nothing has been erased yet — cancel before this date and everything comes back.'}
            </Text>
            {pending.deferredReason ? (
              <Text style={[styles.body, { color: secondary, marginTop: 8 }]}>
                We are waiting for something to finish first
                {pending.deferredReason === 'pending_payout'
                  ? ': your payout is still being processed.'
                  : pending.deferredReason === 'active_contest'
                    ? ': you are in a contest that has not finished.'
                    : '.'}
              </Text>
            ) : null}
          </View>

          {!isProcessing && (
            <TouchableOpacity
              style={[styles.keepBtn, submitting && styles.deleteBtnDisabled]}
              onPress={askThenCancel}
              disabled={submitting}
              accessibilityRole="button"
              accessibilityLabel="Cancel the scheduled deletion and keep my account"
            >
              {submitting ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.deleteBtnText}>Keep my account</Text>
              )}
            </TouchableOpacity>
          )}

          {renderExportRow()}
        </>
      );
    }

    return (
      <>
        {/* Deferrals are about WHEN, not WHETHER. Stated before anything else so
            the date further down is not a surprise, but they never gate the form. */}
        {deferrals.length > 0 && (
          <View style={[styles.blockerBox, { backgroundColor: inputBg, borderColor: border }]}>
            <Text style={[styles.sectionTitle, { color: textColor }]}>
              One thing has to finish first
            </Text>
            {deferrals.map((d) => (
              <View key={d.code} style={styles.bulletRow}>
                <Text style={[styles.bullet, { color: '#FF4D67' }]}>•</Text>
                <Text style={[styles.body, { color: secondary, flex: 1 }]}>{d.message}</Text>
              </View>
            ))}
            <Text style={[styles.body, { color: secondary, marginTop: 8 }]}>
              You can still ask for deletion now. Your account closes immediately and the data is
              erased once this has settled.
            </Text>
          </View>
        )}

        {balance > 0 && (
          <View style={[styles.blockerBox, { backgroundColor: inputBg, borderColor: border }]}>
            <Text style={[styles.sectionTitle, { color: textColor }]}>
              You still have {balance} coins
            </Text>
            <Text style={[styles.body, { color: secondary }]}>
              These will be forfeited and cannot be recovered. If you want to cash them out,
              withdraw them first and delete your account once the payout is complete.
            </Text>
          </View>
        )}

        <Text style={[styles.sectionTitle, { color: textColor, marginTop: 24 }]}>
          What happens
        </Text>
        {[
          'Your account closes straight away — no one can find you or see your posts.',
          graceDays > 0
            ? `Everything is permanently erased after ${graceDays} days. Sign in before then to cancel.`
            : 'Everything is permanently erased. This cannot be undone.',
          'Your profile, photo, bio, posts, stories, comments, likes and followers are deleted.',
          'Your login is removed, so you cannot sign in again with this account.',
        ].map((line) => (
          <View key={line} style={styles.bulletRow}>
            <Text style={[styles.bullet, { color: secondary }]}>•</Text>
            <Text style={[styles.body, { color: secondary, flex: 1 }]}>{line}</Text>
          </View>
        ))}

        <Text style={[styles.sectionTitle, { color: textColor, marginTop: 20 }]}>
          What we have to keep
        </Text>
        <Text style={[styles.body, { color: secondary }]}>
          Records of payments, coin transactions and contests you took part in are kept for
          accounting and because other players&apos; contest results depend on them. They are no
          longer linked to your name, email or phone number, and your contest photos and videos are
          destroyed with everything else.
        </Text>

        {renderExportRow()}
        {renderRequestForm()}
      </>
    );
  };

  const renderExportRow = () => (
    <TouchableOpacity
      onPress={() => void exportData()}
      disabled={exporting}
      style={[styles.secondaryBtn, { borderColor: border, marginTop: 20 }]}
      accessibilityRole="button"
      accessibilityLabel="Download a copy of my data"
    >
      {exporting ? (
        <ActivityIndicator color={textColor} />
      ) : (
        <>
          <Ionicons name="download-outline" size={18} color={textColor} />
          <Text style={[styles.secondaryBtnText, { color: textColor }]}>
            Download a copy of my data
          </Text>
        </>
      )}
    </TouchableOpacity>
  );

  const renderRequestForm = () => (
    <>
      <Text style={[styles.sectionTitle, { color: textColor, marginTop: 24 }]}>
        Why are you leaving? (optional)
      </Text>
      <TextInput
        value={reason}
        onChangeText={setReason}
        multiline
        numberOfLines={3}
        maxLength={500}
        textAlignVertical="top"
        placeholder="This helps us fix what isn't working."
        placeholderTextColor={secondary}
        style={[styles.input, { backgroundColor: inputBg, borderColor: border, color: textColor }]}
        accessibilityLabel="Reason for leaving, optional"
      />

      <Text style={[styles.sectionTitle, { color: textColor, marginTop: 24 }]}>
        Type {CONFIRM_WORD} to confirm
      </Text>
      <TextInput
        value={confirmText}
        onChangeText={setConfirmText}
        autoCapitalize="characters"
        autoCorrect={false}
        placeholder={CONFIRM_WORD}
        placeholderTextColor={secondary}
        style={[
          styles.confirmInput,
          {
            backgroundColor: inputBg,
            borderColor: confirmed ? '#FF4D67' : border,
            color: textColor,
          },
        ]}
        accessibilityLabel={`Type ${CONFIRM_WORD} to confirm account deletion`}
      />

      <TouchableOpacity
        style={[styles.deleteBtn, !canSubmit && styles.deleteBtnDisabled]}
        onPress={askThenSubmit}
        disabled={!canSubmit}
        accessibilityRole="button"
        accessibilityLabel="Permanently delete my account"
      >
        {submitting ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.deleteBtnText}>Delete my account</Text>
        )}
      </TouchableOpacity>
    </>
  );

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]}>
      {confirmDialog}
      <View style={styles.header}>
        <BackButton size={24} color={textColor} style={styles.backButton} />
        <Text style={[styles.headerTitle, { color: textColor }]}>Delete Account</Text>
      </View>

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {loading ? (
          <ActivityIndicator size="large" color="#FF4D67" style={{ marginTop: 40 }} />
        ) : (
          <>
            {!pending && (
              <View style={[styles.warningBox, { borderColor: '#FF4D67' }]}>
                <Ionicons name="warning-outline" size={20} color="#FF4D67" />
                <Text style={[styles.warningText, { color: textColor }]}>
                  {graceDays > 0
                    ? `Your account closes immediately and is erased after ${graceDays} days.`
                    : 'This cannot be undone. You will not be able to sign in again with this account.'}
                </Text>
              </View>
            )}

            {renderBody()}

            <TouchableOpacity
              onPress={() => router.back()}
              style={styles.cancelBtn}
              accessibilityRole="button"
              accessibilityLabel="Go back"
            >
              <Text style={[styles.cancelText, { color: textColor }]}>Go back</Text>
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 15 },
  backButton: { marginRight: 15 },
  headerTitle: { fontSize: 24, fontFamily: 'Urbanist-Bold', flex: 1 },
  content: { paddingHorizontal: 20, paddingBottom: 48 },
  warningBox: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'flex-start',
    borderWidth: 1,
    borderRadius: 16,
    padding: 14,
    marginBottom: 8,
  },
  warningText: { flex: 1, fontSize: 14, lineHeight: 20, fontFamily: 'Urbanist-SemiBold' },
  blockerBox: { borderWidth: 1, borderRadius: 16, padding: 14, marginTop: 16 },
  sectionTitle: { fontSize: 16, fontFamily: 'Urbanist-Bold', marginBottom: 8 },
  body: { fontSize: 14, lineHeight: 21, fontFamily: 'Urbanist-Regular' },
  bulletRow: { flexDirection: 'row', gap: 8, marginBottom: 4 },
  bullet: { fontSize: 15, lineHeight: 21 },
  input: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 14,
    minHeight: 84,
    fontSize: 15,
    fontFamily: 'Urbanist-Regular',
  },
  confirmInput: {
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 14,
    fontSize: 16,
    fontFamily: 'Urbanist-Bold',
    letterSpacing: 2,
  },
  secondaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 100,
    paddingVertical: 14,
    marginTop: 12,
  },
  secondaryBtnText: { fontSize: 15, fontFamily: 'Urbanist-SemiBold' },
  deleteBtn: {
    backgroundColor: '#FF4D67',
    borderRadius: 100,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 24,
  },
  keepBtn: {
    backgroundColor: '#22A45D',
    borderRadius: 100,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 20,
  },
  deleteBtnDisabled: { opacity: 0.4 },
  deleteBtnText: { color: '#fff', fontSize: 16, fontFamily: 'Urbanist-Bold' },
  cancelBtn: { paddingVertical: 16, alignItems: 'center', marginTop: 8 },
  cancelText: { fontSize: 15, fontFamily: 'Urbanist-SemiBold' },
});
