import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  ScrollView,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useRouter } from 'expo-router';
import { BackButton } from '@/src/components/ui/BackButton';
import { Colors } from '@/constants/theme';
import { callApi } from '@/src/services/api';
import { signOut } from '@/src/services/auth';
import { emitToast } from '@/src/lib/toastBridge';
import { reportError } from '@/src/lib/reportError';
import { Ionicons } from '@/src/lib/icons';

/**
 * Delete account.
 *
 * Both app stores require an in-app deletion path and there was none — no screen,
 * no endpoint. The flow is deliberately explicit rather than a single tap:
 *
 *  1. Ask the server what deleting would do right now: whether it is allowed, and
 *     how many coins would be forfeited. Refusals are explained (a payout in
 *     flight, a contest still running) instead of a generic error.
 *  2. State plainly what is deleted and what is kept, matching what the server
 *     actually does (transaction records are retained against an anonymised id).
 *  3. Require the user to type DELETE, because this is irreversible.
 */

interface Blocker {
  code: string;
  message: string;
}

interface Eligibility {
  deletable: boolean;
  blockers: Blocker[];
  balance: number;
}

const CONFIRM_WORD = 'DELETE';

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
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await callApi('accountDeletionStatus');
        if (!cancelled) setEligibility(res);
      } catch (e: any) {
        if (!cancelled) setLoadError(e?.message || 'Could not check your account status.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const confirmed = confirmText.trim().toUpperCase() === CONFIRM_WORD;
  const canDelete = !!eligibility?.deletable && confirmed && !deleting;

  const performDelete = async () => {
    if (!canDelete) return;
    setDeleting(true);
    try {
      await callApi('deleteAccount', { confirm: true, reason: reason.trim() || undefined });
      // The server has already deleted the Firebase login; sign out locally so
      // cached state and the push token are cleared too.
      await signOut().catch(() => {});
      emitToast('Your account has been deleted.', 'success');
      router.replace('/auth/login');
    } catch (e: any) {
      reportError(e, { screen: 'delete-account' });
      emitToast(e?.message || 'Could not delete your account. Please try again.', 'error');
      setDeleting(false);
    }
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]}>
      <View style={styles.header}>
        <BackButton size={24} color={textColor} style={styles.backButton} />
        <Text style={[styles.headerTitle, { color: textColor }]}>Delete Account</Text>
      </View>

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {loading ? (
          <ActivityIndicator size="large" color="#FF4D67" style={{ marginTop: 40 }} />
        ) : loadError ? (
          <Text style={[styles.body, { color: secondary }]}>{loadError}</Text>
        ) : (
          <>
            <View style={[styles.warningBox, { borderColor: '#FF4D67' }]}>
              <Ionicons name="warning-outline" size={20} color="#FF4D67" />
              <Text style={[styles.warningText, { color: textColor }]}>
                This cannot be undone. You will not be able to sign in again with this account.
              </Text>
            </View>

            {/* Blockers first: if we cannot proceed, say why before anything else. */}
            {!eligibility?.deletable && (
              <View style={[styles.blockerBox, { backgroundColor: inputBg, borderColor: border }]}>
                <Text style={[styles.sectionTitle, { color: textColor }]}>
                  You can&apos;t delete your account just yet
                </Text>
                {eligibility?.blockers.map((b) => (
                  <View key={b.code} style={styles.bulletRow}>
                    <Text style={[styles.bullet, { color: '#FF4D67' }]}>•</Text>
                    <Text style={[styles.body, { color: secondary, flex: 1 }]}>{b.message}</Text>
                  </View>
                ))}
              </View>
            )}

            {(eligibility?.balance ?? 0) > 0 && eligibility?.deletable && (
              <View style={[styles.blockerBox, { backgroundColor: inputBg, borderColor: border }]}>
                <Text style={[styles.sectionTitle, { color: textColor }]}>
                  You still have {eligibility.balance} coins
                </Text>
                <Text style={[styles.body, { color: secondary }]}>
                  These will be forfeited and cannot be recovered. If you want to cash them out, withdraw
                  them first and delete your account once the payout is complete.
                </Text>
              </View>
            )}

            <Text style={[styles.sectionTitle, { color: textColor, marginTop: 24 }]}>
              What gets deleted
            </Text>
            {[
              'Your profile, photo, bio and contact details',
              'Your posts, stories, comments and likes',
              'Your followers and who you follow',
              'Your saved posts and notifications',
              'Your login — permanently',
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
              longer linked to your name, email or phone number.
            </Text>

            {eligibility?.deletable && (
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
                    { backgroundColor: inputBg, borderColor: confirmed ? '#FF4D67' : border, color: textColor },
                  ]}
                  accessibilityLabel={`Type ${CONFIRM_WORD} to confirm account deletion`}
                />

                <TouchableOpacity
                  style={[styles.deleteBtn, !canDelete && styles.deleteBtnDisabled]}
                  onPress={performDelete}
                  disabled={!canDelete}
                  accessibilityRole="button"
                  accessibilityLabel="Permanently delete my account"
                >
                  {deleting ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.deleteBtnText}>Permanently delete my account</Text>
                  )}
                </TouchableOpacity>
              </>
            )}

            <TouchableOpacity
              onPress={() => router.back()}
              style={styles.cancelBtn}
              accessibilityRole="button"
              accessibilityLabel="Keep my account"
            >
              <Text style={[styles.cancelText, { color: textColor }]}>Keep my account</Text>
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
  deleteBtn: {
    backgroundColor: '#FF4D67',
    borderRadius: 100,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 24,
  },
  deleteBtnDisabled: { opacity: 0.4 },
  deleteBtnText: { color: '#fff', fontSize: 16, fontFamily: 'Urbanist-Bold' },
  cancelBtn: { paddingVertical: 16, alignItems: 'center', marginTop: 8 },
  cancelText: { fontSize: 15, fontFamily: 'Urbanist-SemiBold' },
});
