import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  useColorScheme,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert } from '@/src/lib/appAlert';
import { BackButton } from '@/src/components/ui/BackButton';
import { Ionicons } from '@/src/lib/icons';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/src/hooks/useAuth';
import { useProfile } from '@/src/hooks/useProfileData';
import { callApi } from '@/src/services/api';
import { isReauthRequired } from '@/src/services/auth/reauth';
import {
  hasRewardOffer,
  progressLabel,
  remainingMessage,
  rewardExplainer,
  rewardOutcomeMessage,
  type RewardOutcome,
} from '@/src/lib/verificationReward';
import { verificationRewardService, verificationStatusKey } from '@/src/services/verificationReward';

const BRAND = '#7C3AED';
const OK = '#16A34A';
const PENDING = '#D97706';

type Kind = 'email' | 'phone';

/**
 * Email + mobile verification, and the registration reward progress.
 *
 * Verification here PROVES the email / number already on the account (the
 * server's verify-only OTP mode — nothing moves, so no re-authentication). Adding
 * or changing an email / number is the Edit Profile flow, which re-authenticates
 * and verifies the new value; a changed value is never treated as verified until
 * its own code is confirmed.
 *
 * Every reward message shown here comes from the server's response. Nothing
 * claims coins were credited unless the server says it credited them.
 */
export default function VerificationScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const uid = user?.uid;
  const isDark = useColorScheme() === 'dark';
  const bg = isDark ? Colors.dark.background : Colors.light.background;
  const text = isDark ? Colors.dark.text : Colors.light.text;
  const sub = isDark ? '#9BA1A6' : '#6B7280';
  const card = isDark ? '#1F222A' : '#FFFFFF';
  const border = isDark ? '#35383F' : '#EEEEEE';

  const { data: profile, refetch: refetchProfile } = useProfile(uid || '');
  const statusQuery = useQuery({
    queryKey: verificationStatusKey(uid),
    queryFn: verificationRewardService.getStatus,
    enabled: !!uid,
  });
  const status = statusQuery.data;

  const [otpFor, setOtpFor] = useState<Kind | null>(null);
  const [code, setCode] = useState('');
  const [sending, setSending] = useState<Kind | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [checking, setChecking] = useState(false);
  const [cooldown, setCooldown] = useState<Record<Kind, number>>({ email: 0, phone: 0 });

  useEffect(() => {
    const t = setInterval(() => {
      setCooldown((c) => ({ email: Math.max(0, c.email - 1), phone: Math.max(0, c.phone - 1) }));
    }, 1000);
    return () => clearInterval(t);
  }, []);

  const refreshAll = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: verificationStatusKey(uid) }),
      refetchProfile(),
    ]);
  };

  const announce = (outcome: RewardOutcome | undefined, fallbackTitle: string, fallbackBody: string) => {
    const msg = rewardOutcomeMessage(outcome);
    if (outcome?.credited) Alert.alert('Reward unlocked 🎉', msg || 'Bonus Diamond aapke wallet me aa gaye!');
    else if (msg) Alert.alert(fallbackTitle, `${fallbackBody}\n\n${msg}`);
    else Alert.alert(fallbackTitle, fallbackBody);
  };

  const sendCode = async (kind: Kind) => {
    const current = kind === 'email' ? (profile as any)?.email : (profile as any)?.phone;
    if (!current) {
      // Adding a new email / number goes through Edit Profile (re-auth + verify).
      router.push('/profile/manage/edit');
      return;
    }
    setSending(kind);
    try {
      const res: any = await callApi(kind === 'email' ? 'sendEmailOtp' : 'sendPhoneOtp', kind === 'email' ? { newEmail: current } : { newPhone: current });
      setOtpFor(kind);
      setCode('');
      setCooldown((c) => ({ ...c, [kind]: Number(res?.cooldownSeconds) || 60 }));
    } catch (error: any) {
      if (isReauthRequired(error)) {
        Alert.alert('Confirm it’s you', 'Please update this from Edit Profile, where we can confirm it’s you first.');
        router.push('/profile/manage/edit');
        return;
      }
      Alert.alert("Couldn't send the code", error?.message || 'Please try again in a moment.');
    } finally {
      setSending(null);
    }
  };

  const verifyCode = async () => {
    if (!otpFor) return;
    if (!/^\d{6}$/.test(code)) {
      Alert.alert('Invalid code', 'Please enter the 6-digit code.');
      return;
    }
    setVerifying(true);
    try {
      const res: any = await callApi(otpFor === 'email' ? 'verifyEmailOtp' : 'verifyPhoneOtp', { otp: code });
      const label = otpFor === 'email' ? 'Email verified' : 'Mobile number verified';
      setOtpFor(null);
      setCode('');
      await refreshAll();
      announce(res?.verificationReward, label, otpFor === 'email' ? 'Your email address is now verified.' : 'Your mobile number is now verified.');
    } catch (error: any) {
      Alert.alert('Verification failed', error?.message || 'That code did not work. Please try again.');
    } finally {
      setVerifying(false);
    }
  };

  /** Re-check with the server (e.g. after tapping the email link), then try the bonus. */
  const recheck = async () => {
    setChecking(true);
    try {
      const res = await verificationRewardService.refresh();
      queryClient.setQueryData(verificationStatusKey(uid), res.status);
      await refetchProfile();
      announce(res.reward, 'Status updated', remainingMessage(res.status) || 'Your verification is up to date.');
    } catch (error: any) {
      Alert.alert("Couldn't check right now", error?.message || 'Please try again in a moment.');
    } finally {
      setChecking(false);
    }
  };

  // A render FUNCTION, not a nested component: a component declared in here would
  // be a new type on every render, remounting the code input on each keystroke.
  const renderSection = (kind: Kind) => {
    if (!status) return null;
    const verified = kind === 'email' ? status.emailVerified : status.phoneVerified;
    const masked = kind === 'email' ? status.email : status.phone;
    const has = kind === 'email' ? status.hasEmail : status.hasPhone;
    const label = kind === 'email' ? 'Email' : 'Mobile number';
    const cd = cooldown[kind];
    const open = otpFor === kind;
    return (
      <View style={[styles.card, { backgroundColor: card, borderColor: border }]}>
        <View style={styles.cardHead}>
          <Ionicons name={verified ? 'checkmark-circle' : 'alert-circle-outline'} size={22} color={verified ? OK : PENDING} />
          <View style={{ flex: 1, marginLeft: 10 }}>
            <Text style={[styles.cardTitle, { color: text }]}>{label}</Text>
            <Text style={[styles.cardValue, { color: sub }]}>{masked || `No ${kind === 'email' ? 'email' : 'mobile number'} added`}</Text>
          </View>
          <Text style={[styles.state, { color: verified ? OK : PENDING }]}>{verified ? 'Verified' : 'Not verified'}</Text>
        </View>

        {!verified ? (
          open ? (
            <View>
              <Text style={[styles.help, { color: sub }]}>Enter the 6-digit code we sent to {masked}.</Text>
              <TextInput
                value={code}
                onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))}
                keyboardType="number-pad"
                maxLength={6}
                autoFocus
                textContentType="oneTimeCode"
                autoComplete="one-time-code"
                placeholder="------"
                placeholderTextColor={sub}
                accessibilityLabel={`${label} verification code`}
                style={[styles.otp, { color: text, borderColor: border }]}
              />
              <TouchableOpacity style={[styles.primaryBtn, verifying && styles.disabled]} disabled={verifying} onPress={verifyCode} accessibilityRole="button">
                {verifying ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryBtnText}>Verify</Text>}
              </TouchableOpacity>
              <View style={styles.inlineRow}>
                <TouchableOpacity disabled={cd > 0 || sending === kind} onPress={() => sendCode(kind)} accessibilityRole="button">
                  <Text style={[styles.link, { color: cd > 0 ? sub : BRAND }]}>{cd > 0 ? `Resend code in ${cd}s` : 'Resend code'}</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => { setOtpFor(null); setCode(''); }} accessibilityRole="button">
                  <Text style={[styles.link, { color: sub }]}>Cancel</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : (
            <TouchableOpacity
              style={[styles.primaryBtn, (sending === kind || cd > 0) && styles.disabled]}
              disabled={sending === kind || cd > 0}
              onPress={() => sendCode(kind)}
              accessibilityRole="button"
            >
              {sending === kind ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.primaryBtnText}>
                  {!has ? `Add ${kind === 'email' ? 'email' : 'mobile number'}` : cd > 0 ? `Resend in ${cd}s` : `Verify ${kind === 'email' ? 'email' : 'mobile'}`}
                </Text>
              )}
            </TouchableOpacity>
          )
        ) : null}
      </View>
    );
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: bg }]}>
      <View style={styles.header}>
        <BackButton size={24} color={text} style={{ marginRight: 12 }} />
        <Text style={[styles.headerTitle, { color: text }]}>Verification</Text>
      </View>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {statusQuery.isLoading ? (
            <ActivityIndicator style={{ marginTop: 40 }} color={BRAND} />
          ) : statusQuery.isError || !status ? (
            <View style={styles.center}>
              <Text style={[styles.help, { color: sub, textAlign: 'center' }]}>Couldn&apos;t load your verification status. Check your connection.</Text>
              <TouchableOpacity style={styles.primaryBtn} onPress={() => statusQuery.refetch()} accessibilityRole="button">
                <Text style={styles.primaryBtnText}>Try again</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              {hasRewardOffer(status) ? (
                <View style={[styles.rewardCard, { borderColor: border }]}>
                  <Text style={styles.rewardProgress}>{progressLabel(status)}</Text>
                  <Text style={[styles.help, { color: text, textAlign: 'center' }]}>
                    {status.completed ? `You've unlocked the full ${status.totalReward} Diamond reward. Thank you for verifying!` : rewardExplainer(status)}
                  </Text>
                  {!status.completed ? <Text style={[styles.help, { color: sub, textAlign: 'center', marginBottom: 0 }]}>{remainingMessage(status)}</Text> : null}
                </View>
              ) : null}

              {status.requireEmail || !hasRewardOffer(status) ? renderSection('email') : null}
              {status.requirePhone || !hasRewardOffer(status) ? renderSection('phone') : null}

              {!(status.emailVerified && status.phoneVerified) || (hasRewardOffer(status) && !status.completed) ? (
                <TouchableOpacity style={[styles.outlineBtn, checking && styles.disabled]} disabled={checking} onPress={recheck} accessibilityRole="button">
                  {checking ? <ActivityIndicator color={BRAND} /> : <Text style={styles.outlineBtnText}>I verified already — check again</Text>}
                </TouchableOpacity>
              ) : null}
              <Text style={[styles.note, { color: sub }]}>
                To use a different email or mobile number, change it in Edit Profile — the new one must be verified with its own code.
              </Text>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14 },
  headerTitle: { fontSize: 22, fontFamily: 'Urbanist-Bold' },
  content: { padding: 20, paddingBottom: 40 },
  center: { alignItems: 'stretch', marginTop: 40 },
  rewardCard: { borderWidth: 1, borderRadius: 16, padding: 16, marginBottom: 16, backgroundColor: 'rgba(124,58,237,0.08)' },
  rewardProgress: { color: BRAND, fontFamily: 'Urbanist-Bold', fontSize: 24, textAlign: 'center', marginBottom: 8 },
  card: { borderWidth: 1, borderRadius: 16, padding: 16, marginBottom: 14 },
  cardHead: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  cardTitle: { fontFamily: 'Urbanist-Bold', fontSize: 16 },
  cardValue: { fontFamily: 'Urbanist-Regular', fontSize: 13, marginTop: 2 },
  state: { fontFamily: 'Urbanist-SemiBold', fontSize: 13 },
  help: { fontFamily: 'Urbanist-Regular', fontSize: 14, lineHeight: 20, marginBottom: 10 },
  otp: { borderWidth: 1, borderRadius: 12, fontSize: 22, letterSpacing: 8, textAlign: 'center', paddingVertical: 10, marginBottom: 12, fontFamily: 'Urbanist-Bold' },
  inlineRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 12 },
  link: { fontFamily: 'Urbanist-SemiBold', fontSize: 14 },
  primaryBtn: { backgroundColor: BRAND, borderRadius: 999, paddingVertical: 13, alignItems: 'center' },
  primaryBtnText: { color: '#fff', fontFamily: 'Urbanist-Bold', fontSize: 15 },
  outlineBtn: { borderColor: BRAND, borderWidth: 1.5, borderRadius: 999, paddingVertical: 12, alignItems: 'center', marginTop: 4 },
  outlineBtnText: { color: BRAND, fontFamily: 'Urbanist-Bold', fontSize: 15 },
  disabled: { opacity: 0.6 },
  note: { fontFamily: 'Urbanist-Regular', fontSize: 12, lineHeight: 18, marginTop: 16, textAlign: 'center' },
});
