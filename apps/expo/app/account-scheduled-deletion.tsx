import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  ActivityIndicator,
  TouchableOpacity,
  ScrollView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { Colors } from '@/constants/theme';
import { Ionicons } from '@/src/lib/icons';
import { useQueryClient } from '@tanstack/react-query';
import { readApi, callApi } from '@/src/services/api';
import { signOut } from '@/src/services/auth';
import { auth } from '@/src/services/firebase/initFirebase';
import { emitToast } from '@/src/lib/toastBridge';
import { reportError } from '@/src/lib/reportError';
import { useConfirm } from '@/src/components/modals/ConfirmDialog';

/**
 * The login gate for an account that is scheduled for deletion.
 *
 * A user in the grace period who signs back in used to land in the normal app with
 * no hint their account was closing — `/read/users/:id` hides pending accounts, so
 * nothing surfaced the state and every write just failed with a raw error. This
 * screen is where such a session is routed instead (by app/_layout.tsx's guard and
 * by app/splash.tsx on cold start): it states WHEN the account will be erased, how
 * long is left, and gives the one action that matters — bringing it back.
 */

interface DeletionInfo {
  requestStatus: 'pending' | 'processing';
  scheduledFor: number | null;
  daysRemaining: number | null;
  deferredReason: string | null;
}

const formatDate = (ms?: number | null): string => {
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  } catch {
    return new Date(ms).toDateString();
  }
};

export default function AccountScheduledDeletionScreen() {
  const router = useRouter();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const textColor = isDark ? '#fff' : '#212121';
  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;
  const secondary = isDark ? '#A0A0A0' : '#666';
  const cardBg = isDark ? '#1F222A' : '#FAFAFA';

  const [loading, setLoading] = useState(true);
  const [info, setInfo] = useState<DeletionInfo | null>(null);
  const [working, setWorking] = useState(false);
  const { confirm, dialog: confirmDialog } = useConfirm();
  const queryClient = useQueryClient();

  const load = useCallback(async () => {
    try {
      const res: any = await readApi('/read/me/status');
      // No longer scheduled (cancelled elsewhere, or grace already ran) — this screen
      // has nothing left to do, so hand the user back to the app.
      if (res?.status !== 'pending_deletion' || !res?.deletion) {
        router.replace('/home');
        return;
      }
      setInfo(res.deletion as DeletionInfo);
    } catch (e: any) {
      // A status check that cannot complete must not trap the user on a blank gate.
      // The cancel action below still works, and sign-out is always available.
      reportError(e, { screen: 'account-scheduled-deletion', step: 'load' });
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  const doCancel = async () => {
    setWorking(true);
    try {
      await callApi('cancelAccountDeletion');
      // Update the guard's cached status BEFORE navigating, or DeletionGuard would
      // still read the stale "pending" and bounce the user straight back here.
      const uid = auth.currentUser?.uid;
      if (uid) queryClient.setQueryData(['me-status', uid], { status: 'active', deletion: null });
      emitToast('Welcome back — your account is no longer scheduled for deletion.', 'success');
      router.replace('/home');
    } catch (e: any) {
      reportError(e, { screen: 'account-scheduled-deletion', step: 'cancel' });
      emitToast(e?.message || 'Could not cancel the deletion. Please try again.', 'error');
      setWorking(false);
    }
  };

  const askThenCancel = () => {
    void confirm({
      title: 'Keep your account?',
      message: 'Your account will be restored and the scheduled deletion cancelled.',
      confirmLabel: 'Keep my account',
      cancelLabel: 'Back',
      onConfirm: doCancel,
    });
  };

  const doSignOut = async () => {
    setWorking(true);
    try {
      // The account is out of service, so skip the authenticated push-token detach:
      // it cannot succeed and its failure would surface as "session expired".
      await signOut({ skipPushTokenUnregister: true });
      // Auth-state change routes to login; nudge for the direct-nav case.
      router.replace('/auth/login');
    } catch (e: any) {
      reportError(e, { screen: 'account-scheduled-deletion', step: 'signout' });
      setWorking(false);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor, justifyContent: 'center' }]}>
        <ActivityIndicator size="large" color="#FF4D67" />
      </SafeAreaView>
    );
  }

  const processing = info?.requestStatus === 'processing';
  const when = formatDate(info?.scheduledFor);
  const days = info?.daysRemaining ?? null;

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]}>
      {confirmDialog}
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.iconWrap}>
          <Ionicons name={processing ? 'trash-outline' : 'time-outline'} size={56} color="#FF4D67" />
        </View>

        <Text style={[styles.title, { color: textColor }]}>
          {processing ? 'Your account is being deleted' : 'Your account is scheduled for deletion'}
        </Text>

        {!processing && (
          <View style={[styles.card, { backgroundColor: cardBg, borderColor: '#FF4D67' }]}>
            {when ? (
              <Text style={[styles.cardBig, { color: textColor }]}>
                {days !== null && days > 0
                  ? `${days} ${days === 1 ? 'day' : 'days'} left`
                  : 'Being deleted very soon'}
              </Text>
            ) : null}
            <Text style={[styles.cardSub, { color: secondary }]}>
              {when
                ? `Everything is permanently erased on ${when}.`
                : 'Your account is closed and will be permanently erased soon.'}
            </Text>
          </View>
        )}

        <Text style={[styles.body, { color: secondary }]}>
          {processing
            ? 'Deletion has started and can no longer be cancelled. You are signed out from here.'
            : 'Your account is closed and hidden from other people, but nothing has been erased yet. Cancel before the date above and your profile, entries, stories and followers all come back.'}
        </Text>

        {info?.deferredReason && !processing ? (
          <Text style={[styles.body, { color: secondary, marginTop: 10 }]}>
            {info.deferredReason === 'pending_payout'
              ? 'We are finishing your payout first, then the countdown continues.'
              : info.deferredReason === 'active_contest'
                ? 'We are waiting for a contest you entered to finish first.'
                : 'We are waiting for something to finish first.'}
          </Text>
        ) : null}

        {!processing && (
          <TouchableOpacity
            style={[styles.keepBtn, working && styles.btnDisabled]}
            onPress={askThenCancel}
            disabled={working}
            accessibilityRole="button"
            accessibilityLabel="Cancel the scheduled deletion and keep my account"
          >
            {working ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.keepBtnText}>Keep my account</Text>
            )}
          </TouchableOpacity>
        )}

        <TouchableOpacity
          style={styles.signOutBtn}
          onPress={doSignOut}
          disabled={working}
          accessibilityRole="button"
          accessibilityLabel="Sign out"
        >
          <Text style={[styles.signOutText, { color: textColor }]}>Sign out</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 28, paddingVertical: 40 },
  iconWrap: { alignItems: 'center', marginBottom: 20 },
  title: { fontSize: 24, fontFamily: 'Urbanist-Bold', textAlign: 'center', marginBottom: 18 },
  card: { borderWidth: 1, borderRadius: 16, padding: 16, marginBottom: 18, alignItems: 'center' },
  cardBig: { fontSize: 22, fontFamily: 'Urbanist-Bold', marginBottom: 4 },
  cardSub: { fontSize: 14, fontFamily: 'Urbanist-Regular', textAlign: 'center', lineHeight: 20 },
  body: { fontSize: 15, fontFamily: 'Urbanist-Regular', lineHeight: 22, textAlign: 'center' },
  keepBtn: {
    backgroundColor: '#22A45D',
    borderRadius: 100,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 28,
  },
  keepBtnText: { color: '#fff', fontSize: 16, fontFamily: 'Urbanist-Bold' },
  btnDisabled: { opacity: 0.5 },
  signOutBtn: { paddingVertical: 16, alignItems: 'center', marginTop: 12 },
  signOutText: { fontSize: 15, fontFamily: 'Urbanist-SemiBold' },
});
