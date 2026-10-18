import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal, ScrollView } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useRouter, useSegments } from 'expo-router';
import { useThemeColor } from '@/hooks/use-theme-color';
import { useAuth } from '@/src/hooks/useAuth';
import { Ionicons } from '@/src/lib/icons';
import { CloseIcon } from '@/src/components/ui/CloseIcon';
import {
  progressLabel,
  remainingMessage,
  rewardExplainer,
  shouldShowVerificationPopup,
} from '@/src/lib/verificationReward';
import { verificationRewardService, verificationStatusKey } from '@/src/services/verificationReward';

const BRAND_PRIMARY = '#7C3AED';
const OK = '#16A34A';
const PENDING = '#D97706';

/**
 * "You got your welcome coins — verify email AND mobile for the rest."
 *
 * Mounted ONCE in app/_layout.tsx, so screen re-renders cannot duplicate it.
 * When to show is the server's call (`promptDue`: right after signup, then 3 days
 * after the first showing, then weekly, at most 5 times — all admin-configurable),
 * so it survives reinstalls and is consistent across devices. Opening it records
 * the showing server-side; "Remind me later" just closes it. It never blocks the
 * app, and never claims coins were credited — only the server's response can.
 */
export function VerificationRewardPopup() {
  const { user } = useAuth();
  const router = useRouter();
  const segments = useSegments();
  const onHome = segments[0] === 'home';
  const shownThisSession = useRef(false);
  const [open, setOpen] = useState(false);

  const cardBg = useThemeColor({ light: '#FFFFFF', dark: '#1F222A' }, 'background');
  const textColor = useThemeColor({}, 'text');
  const subTextColor = useThemeColor({ light: '#4B5563', dark: '#C7C9D1' }, 'text');
  const rowBg = useThemeColor({ light: '#F5F3FF', dark: '#2A2D36' }, 'background');

  const { data: status } = useQuery({
    queryKey: verificationStatusKey(user?.uid),
    queryFn: verificationRewardService.getStatus,
    // Only when it could matter: signed in and on home. Not retried noisily —
    // a missed fetch just means no popup this time.
    enabled: !!user && onHome && !shownThisSession.current,
    staleTime: 60_000,
    retry: 1,
  });

  useEffect(() => {
    if (open) return;
    if (shouldShowVerificationPopup({ status, signedIn: !!user, onHome, shownThisSession: shownThisSession.current })) {
      shownThisSession.current = true;
      setOpen(true);
      void verificationRewardService.markPromptShown();
    }
  }, [status, user, onHome, open]);

  if (!open || !status) return null;

  const close = () => setOpen(false);
  const goVerify = () => {
    setOpen(false);
    router.push('/profile/manage/verification' as any);
  };

  const Row = ({ label, verified, value }: { label: string; verified: boolean; value: string | null }) => (
    <View style={[styles.row, { backgroundColor: rowBg }]} accessible accessibilityLabel={`${label}: ${verified ? 'verified' : 'not verified'}`}>
      <Ionicons name={verified ? 'checkmark-circle' : 'alert-circle-outline'} size={20} color={verified ? OK : PENDING} />
      <View style={{ flex: 1, marginLeft: 10 }}>
        <Text style={[styles.rowLabel, { color: textColor }]}>{label}</Text>
        {value ? <Text style={[styles.rowValue, { color: subTextColor }]}>{value}</Text> : null}
      </View>
      <Text style={[styles.rowState, { color: verified ? OK : PENDING }]}>{verified ? 'Verified' : 'Not verified'}</Text>
    </View>
  );

  return (
    <Modal animationType="fade" transparent visible onRequestClose={close} statusBarTranslucent>
      <View style={styles.centeredView}>
        <View style={[styles.modalView, { backgroundColor: cardBg }]} accessibilityViewIsModal>
          <TouchableOpacity style={styles.closeButton} onPress={close} accessibilityRole="button" accessibilityLabel="Close">
            <CloseIcon variant="circle" />
          </TouchableOpacity>
          <ScrollView contentContainerStyle={{ paddingTop: 8 }} showsVerticalScrollIndicator={false}>
            <Text style={styles.emoji} accessibilityElementsHidden>🎉</Text>
            <Text style={[styles.title, { color: textColor }]}>
              {status.registrationReward} welcome coins added!
            </Text>
            <Text style={[styles.body, { color: subTextColor }]}>{rewardExplainer(status)}</Text>

            <View style={styles.progressPill}>
              <Ionicons name="wallet-outline" size={16} color={BRAND_PRIMARY} />
              <Text style={styles.progressText}>Reward: {progressLabel(status)}</Text>
            </View>

            {status.requireEmail ? <Row label="Email" verified={status.emailVerified} value={status.email} /> : null}
            {status.requirePhone ? <Row label="Mobile" verified={status.phoneVerified} value={status.phone} /> : null}

            <Text style={[styles.hint, { color: subTextColor }]}>{remainingMessage(status)}</Text>
          </ScrollView>

          <View style={styles.actions}>
            {status.requireEmail && !status.emailVerified ? (
              <TouchableOpacity style={styles.primaryBtn} onPress={goVerify} accessibilityRole="button">
                <Text style={styles.primaryBtnText}>Verify email</Text>
              </TouchableOpacity>
            ) : null}
            {status.requirePhone && !status.phoneVerified ? (
              <TouchableOpacity
                style={status.requireEmail && !status.emailVerified ? styles.outlineBtn : styles.primaryBtn}
                onPress={goVerify}
                accessibilityRole="button"
              >
                <Text style={status.requireEmail && !status.emailVerified ? styles.outlineBtnText : styles.primaryBtnText}>
                  Verify mobile
                </Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity style={styles.linkBtn} onPress={close} accessibilityRole="button">
              <Text style={[styles.linkBtnText, { color: subTextColor }]}>Remind me later</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  centeredView: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.5)', paddingHorizontal: 20 },
  modalView: {
    width: '100%', maxWidth: 420, maxHeight: '88%', borderRadius: 20, padding: 20,
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.25, shadowRadius: 8, elevation: 6,
  },
  closeButton: { position: 'absolute', right: 12, top: 12, zIndex: 2, padding: 4 },
  emoji: { fontSize: 40, textAlign: 'center', marginBottom: 4 },
  title: { fontSize: 20, fontFamily: 'Urbanist-Bold', textAlign: 'center', marginBottom: 8, paddingHorizontal: 24 },
  body: { fontSize: 14, lineHeight: 21, fontFamily: 'Urbanist-Regular', textAlign: 'center', marginBottom: 14 },
  progressPill: {
    flexDirection: 'row', alignItems: 'center', alignSelf: 'center', gap: 6,
    backgroundColor: 'rgba(124,58,237,0.12)', borderRadius: 999, paddingHorizontal: 14, paddingVertical: 6, marginBottom: 14,
  },
  progressText: { color: BRAND_PRIMARY, fontFamily: 'Urbanist-Bold', fontSize: 14 },
  row: { flexDirection: 'row', alignItems: 'center', borderRadius: 12, padding: 12, marginBottom: 8 },
  rowLabel: { fontFamily: 'Urbanist-Bold', fontSize: 15 },
  rowValue: { fontFamily: 'Urbanist-Regular', fontSize: 13, marginTop: 2 },
  rowState: { fontFamily: 'Urbanist-SemiBold', fontSize: 13 },
  hint: { fontSize: 13, fontFamily: 'Urbanist-Regular', textAlign: 'center', marginTop: 6 },
  actions: { marginTop: 16, gap: 10 },
  primaryBtn: { backgroundColor: BRAND_PRIMARY, borderRadius: 999, paddingVertical: 13, alignItems: 'center' },
  primaryBtnText: { color: '#FFFFFF', fontFamily: 'Urbanist-Bold', fontSize: 16 },
  outlineBtn: { borderColor: BRAND_PRIMARY, borderWidth: 1.5, borderRadius: 999, paddingVertical: 12, alignItems: 'center' },
  outlineBtnText: { color: BRAND_PRIMARY, fontFamily: 'Urbanist-Bold', fontSize: 16 },
  linkBtn: { paddingVertical: 8, alignItems: 'center' },
  linkBtnText: { fontFamily: 'Urbanist-SemiBold', fontSize: 14 },
});
