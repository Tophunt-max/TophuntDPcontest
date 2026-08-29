import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { BackButton } from '@/src/components/ui/BackButton';
import { Colors } from '@/constants/theme';
import { Ionicons } from '@/src/lib/icons';
import { useAuth } from '@/src/hooks/useAuth';
import { passwordRequirements, validatePassword } from '@/src/lib/passwordPolicy';
import {
  changePassword,
  describePasswordlessAccount,
  hasPasswordProvider,
} from '@/src/services/auth/changePassword';
import { emitToast } from '@/src/lib/toastBridge';
import { reportError } from '@/src/lib/reportError';

/**
 * Change password.
 *
 * The app could only reset a FORGOTTEN password, by email link or phone OTP. A
 * signed-in user who simply wanted a new one had to log out and claim to have
 * forgotten it — so the safe, routine action was harder than the recovery action.
 *
 * The current password is required, not for ceremony: Firebase rejects a password
 * change on an old session with `auth/requires-recent-login`, so without
 * reauthenticating inline this screen would work for a few minutes after sign-in
 * and then fail inexplicably. It is also what stops someone with an unlocked
 * phone locking the owner out of an account that holds a coin balance.
 *
 * Accounts with no password (Google/Apple/Facebook/phone-only) do not get a form.
 * The Settings row is hidden for them, and reaching this route directly explains
 * which provider owns their credentials instead of showing a form that could only
 * fail.
 */
export default function ChangePasswordScreen() {
  const router = useRouter();
  const isDark = useColorScheme() === 'dark';
  const { user, loading: authLoading } = useAuth();

  const textColor = isDark ? '#fff' : '#212121';
  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;
  const secondary = isDark ? '#A0A0A0' : '#666';
  const inputBg = isDark ? '#1F222A' : '#FAFAFA';
  const border = isDark ? '#35383F' : '#EEEEEE';

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNext, setShowNext] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requirements = useMemo(() => passwordRequirements(next), [next]);
  const mismatch = confirm.length > 0 && next !== confirm;
  const canSubmit =
    !submitting &&
    current.length > 0 &&
    validatePassword(next) === null &&
    next === confirm;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await changePassword(current, next);
      emitToast('Your password has been changed.', 'success');
      router.back();
    } catch (e: any) {
      // The service has already turned Firebase codes into readable copy, so this
      // renders inline rather than guessing at a friendlier message.
      setError(e?.message || 'Could not change your password. Please try again.');
      // A wrong current password is the user's own typo, not a fault worth
      // reporting; anything else is.
      if (!e?.code || !String(e.code).includes('credential')) {
        reportError(e, { screen: 'change-password', code: e?.code });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const header = (
    <View style={styles.header}>
      <BackButton size={24} color={textColor} style={styles.backButton} />
      <Text style={[styles.headerTitle, { color: textColor }]}>Change Password</Text>
    </View>
  );

  if (authLoading) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor }]}>
        {header}
        <View style={styles.center}>
          <ActivityIndicator color="#FF4D67" />
        </View>
      </SafeAreaView>
    );
  }

  // No password to change — explain, do not present a form that cannot succeed.
  if (!hasPasswordProvider(user)) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor }]}>
        {header}
        <View style={styles.content}>
          <View style={[styles.infoBox, { backgroundColor: inputBg, borderColor: border }]}>
            <Ionicons name="information-circle-outline" size={22} color={secondary} />
            <Text style={[styles.infoText, { color: textColor }]}>
              {describePasswordlessAccount(user)}
            </Text>
          </View>
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={() => router.back()}
            accessibilityRole="button"
            accessibilityLabel="Back to settings"
          >
            <Text style={styles.primaryBtnText}>Back to settings</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const field = ({
    label,
    value,
    onChangeText,
    secure,
    toggle,
    onToggle,
    autoComplete,
    accessibilityLabel,
  }: {
    label: string;
    value: string;
    onChangeText: (v: string) => void;
    secure: boolean;
    toggle: boolean;
    onToggle: () => void;
    autoComplete: 'current-password' | 'new-password';
    accessibilityLabel: string;
  }) => (
    <View style={styles.fieldBlock}>
      <Text style={[styles.label, { color: textColor }]}>{label}</Text>
      <View style={[styles.inputRow, { backgroundColor: inputBg, borderColor: border }]}>
        <TextInput
          value={value}
          onChangeText={onChangeText}
          secureTextEntry={secure}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete={autoComplete}
          textContentType={autoComplete === 'new-password' ? 'newPassword' : 'password'}
          placeholder="••••••••"
          placeholderTextColor={secondary}
          style={[styles.input, { color: textColor }]}
          accessibilityLabel={accessibilityLabel}
        />
        <TouchableOpacity
          onPress={onToggle}
          style={styles.eyeBtn}
          accessibilityRole="button"
          accessibilityLabel={toggle ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
        >
          <Ionicons name={toggle ? 'eye-off-outline' : 'eye-outline'} size={20} color={secondary} />
        </TouchableOpacity>
      </View>
    </View>
  );

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]}>
      {header}
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {field({
            label: 'Current password',
            value: current,
            onChangeText: (v) => {
              setCurrent(v);
              setError(null);
            },
            secure: !showCurrent,
            toggle: showCurrent,
            onToggle: () => setShowCurrent((s) => !s),
            autoComplete: 'current-password',
            accessibilityLabel: 'Current password',
          })}

          {field({
            label: 'New password',
            value: next,
            onChangeText: setNext,
            secure: !showNext,
            toggle: showNext,
            onToggle: () => setShowNext((s) => !s),
            autoComplete: 'new-password',
            accessibilityLabel: 'New password',
          })}

          {/* Live checklist, driven by the same predicates as the validator, so it
              can never show all-green on a password the validator would reject. */}
          {next.length > 0 && (
            <View style={styles.requirements}>
              {requirements.map((r) => (
                <View key={r.label} style={styles.requirementRow}>
                  {r.met ? (
                    <Ionicons name="checkmark-circle" size={16} color="#22C55E" />
                  ) : (
                    <View style={[styles.dot, { borderColor: secondary }]} />
                  )}
                  <Text
                    style={[styles.requirementText, { color: r.met ? '#22C55E' : secondary }]}
                  >
                    {r.label}
                  </Text>
                </View>
              ))}
            </View>
          )}

          {field({
            label: 'Confirm new password',
            value: confirm,
            onChangeText: setConfirm,
            secure: !showNext,
            toggle: showNext,
            onToggle: () => setShowNext((s) => !s),
            autoComplete: 'new-password',
            accessibilityLabel: 'Confirm new password',
          })}

          {mismatch && (
            <Text style={styles.inlineError}>Those passwords do not match.</Text>
          )}

          {!!error && (
            <View style={[styles.errorBox, { borderColor: '#FF4D67' }]}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}

          <TouchableOpacity
            style={[styles.primaryBtn, !canSubmit && styles.primaryBtnDisabled]}
            onPress={submit}
            disabled={!canSubmit}
            accessibilityRole="button"
            accessibilityLabel="Change password"
          >
            {submitting ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.primaryBtnText}>Change password</Text>
            )}
          </TouchableOpacity>

          <Text style={[styles.footnote, { color: secondary }]}>
            You will stay signed in on this device. Other devices may ask you to sign in again.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 15 },
  backButton: { marginRight: 15 },
  headerTitle: { fontSize: 24, fontFamily: 'Urbanist-Bold', flex: 1 },
  content: { paddingHorizontal: 20, paddingBottom: 48 },
  fieldBlock: { marginTop: 18 },
  label: { fontSize: 15, fontFamily: 'Urbanist-SemiBold', marginBottom: 8 },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 14,
  },
  input: { flex: 1, paddingVertical: 14, fontSize: 16, fontFamily: 'Urbanist-Regular' },
  eyeBtn: { padding: 6, marginLeft: 6 },
  requirements: { marginTop: 12, gap: 6 },
  requirementRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 12, height: 12, borderRadius: 6, borderWidth: 1.5 },
  requirementText: { fontSize: 13, fontFamily: 'Urbanist-Medium' },
  inlineError: { color: '#FF4D67', fontSize: 13, fontFamily: 'Urbanist-Medium', marginTop: 10 },
  errorBox: { borderWidth: 1, borderRadius: 14, padding: 12, marginTop: 18 },
  errorText: { color: '#FF4D67', fontSize: 14, fontFamily: 'Urbanist-SemiBold', lineHeight: 20 },
  infoBox: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'flex-start',
    borderWidth: 1,
    borderRadius: 16,
    padding: 14,
    marginTop: 8,
  },
  infoText: { flex: 1, fontSize: 14, lineHeight: 21, fontFamily: 'Urbanist-Regular' },
  primaryBtn: {
    backgroundColor: '#FF4D67',
    borderRadius: 100,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 26,
  },
  primaryBtnDisabled: { opacity: 0.5 },
  primaryBtnText: { color: '#fff', fontSize: 16, fontFamily: 'Urbanist-Bold' },
  footnote: { fontSize: 12, fontFamily: 'Urbanist-Regular', marginTop: 16, lineHeight: 17 },
});
