import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { ReanimatedBottomSheet } from './ReanimatedBottomSheet';
import {
  beginReauth,
  completeReauthWithOtp,
  completeReauthWithPassword,
  resendReauthOtp,
  type ReauthPlan,
} from '@/src/services/auth/reauth';

/**
 * "Confirm it's you" before an irreversible or credential-level action.
 *
 * One component for both proofs the server accepts, because the choice is not the
 * screen's business: an account with a password re-enters it (stronger, instant,
 * no SMS cost), and an account without one — phone-only, Google-only, Apple-only —
 * gets a code sent to the identifier already on file. Leaving that decision to
 * each caller is how one of them ends up showing a password field to a user who
 * has never had a password.
 *
 * Usage: render it whenever a sensitive call comes back with `reauth_required`,
 * and re-run that call from `onVerified`.
 */

interface ReauthPromptProps {
  visible: boolean;
  onClose: () => void;
  /** Re-run the action that was refused. */
  onVerified: () => void;
  /** What the user is about to do, e.g. "delete your account". */
  reason?: string;
}

export function ReauthPrompt({ visible, onClose, onVerified, reason }: ReauthPromptProps) {
  const [plan, setPlan] = useState<ReauthPlan | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [value, setValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  // Guards against `beginReauth` running twice — for the OTP path that would send
  // two codes and immediately trip the server's own cooldown on the second.
  const started = useRef(false);

  const prepare = useCallback(async () => {
    setPreparing(true);
    setError(null);
    try {
      const next = await beginReauth();
      setPlan(next);
      setCooldown(next.cooldownSeconds ?? 0);
    } catch (e: any) {
      setError(e?.message || 'Could not start verification. Please try again.');
    } finally {
      setPreparing(false);
    }
  }, []);

  useEffect(() => {
    if (!visible) {
      started.current = false;
      setPlan(null);
      setValue('');
      setError(null);
      setCooldown(0);
      return;
    }
    if (started.current) return;
    started.current = true;
    void prepare();
  }, [visible, prepare]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => setCooldown((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  const submit = async () => {
    if (!plan || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      if (plan.kind === 'password') {
        await completeReauthWithPassword(value);
      } else {
        await completeReauthWithOtp(value.trim());
      }
      setValue('');
      onVerified();
    } catch (e: any) {
      setError(e?.message || 'That did not work. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const resend = async () => {
    if (cooldown > 0) return;
    setError(null);
    try {
      const next = await resendReauthOtp();
      setPlan(next);
      setCooldown(next.cooldownSeconds ?? 60);
    } catch (e: any) {
      setError(e?.message || 'Could not send another code.');
    }
  };

  const isOtp = plan?.kind === 'otp';
  const canSubmit =
    !submitting && (isOtp ? value.trim().length === 6 : value.length > 0);

  return (
    <ReanimatedBottomSheet visible={visible} onClose={onClose} title="Confirm it's you">
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.body}>
          {preparing ? (
            <ActivityIndicator color="#ff4466" style={{ marginVertical: 24 }} />
          ) : !plan ? (
            <>
              <Text style={styles.subtitle}>
                {error || 'Could not start verification.'}
              </Text>
              <TouchableOpacity style={styles.primaryBtn} onPress={() => void prepare()}>
                <Text style={styles.primaryBtnText}>Try again</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <Text style={styles.subtitle}>
                {isOtp
                  ? `For your security, enter the 6-digit code we sent to ${plan.sentTo ?? 'you'}${
                      reason ? ` before you ${reason}` : ''
                    }.`
                  : `For your security, enter your password${
                      reason ? ` before you ${reason}` : ''
                    }.`}
              </Text>

              <TextInput
                style={[styles.input, isOtp && styles.otpInput]}
                value={value}
                onChangeText={setValue}
                placeholder={isOtp ? '000000' : 'Your password'}
                placeholderTextColor="#9E9E9E"
                keyboardType={isOtp ? 'number-pad' : 'default'}
                maxLength={isOtp ? 6 : undefined}
                secureTextEntry={!isOtp}
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
                accessibilityLabel={isOtp ? 'Six digit security code' : 'Your password'}
              />

              {error ? <Text style={styles.error}>{error}</Text> : null}

              <TouchableOpacity
                style={[styles.primaryBtn, !canSubmit && styles.primaryBtnDisabled]}
                onPress={submit}
                disabled={!canSubmit}
                accessibilityRole="button"
                accessibilityLabel="Confirm and continue"
              >
                {submitting ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.primaryBtnText}>Confirm and continue</Text>
                )}
              </TouchableOpacity>

              {isOtp && (
                <TouchableOpacity
                  onPress={resend}
                  disabled={cooldown > 0}
                  style={styles.resendBtn}
                  accessibilityRole="button"
                  accessibilityLabel="Send the code again"
                >
                  <Text style={[styles.resendText, cooldown > 0 && styles.resendTextDisabled]}>
                    {cooldown > 0 ? `Resend code in ${cooldown}s` : 'Resend code'}
                  </Text>
                </TouchableOpacity>
              )}
            </>
          )}

          <TouchableOpacity onPress={onClose} style={styles.cancelBtn} accessibilityRole="button">
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </ReanimatedBottomSheet>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 20, paddingBottom: 24 },
  subtitle: { fontSize: 14, lineHeight: 20, color: '#666', marginBottom: 16 },
  input: {
    borderWidth: 1,
    borderColor: '#EEEEEE',
    backgroundColor: '#FAFAFA',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
    fontSize: 16,
    color: '#212121',
  },
  otpInput: { textAlign: 'center', letterSpacing: 8, fontWeight: '700', fontSize: 20 },
  error: { color: '#ff4466', fontSize: 13, marginTop: 10 },
  primaryBtn: {
    backgroundColor: '#ff4466',
    borderRadius: 100,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 18,
  },
  primaryBtnDisabled: { opacity: 0.4 },
  primaryBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  resendBtn: { alignItems: 'center', paddingVertical: 12 },
  resendText: { color: '#ff4466', fontSize: 14, fontWeight: '600' },
  resendTextDisabled: { color: '#9E9E9E', fontWeight: '400' },
  cancelBtn: { alignItems: 'center', paddingVertical: 12 },
  cancelText: { color: '#666', fontSize: 14 },
});
