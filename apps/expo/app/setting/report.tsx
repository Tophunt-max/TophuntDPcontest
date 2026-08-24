import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  ScrollView,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Linking,
} from 'react-native';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useRouter } from 'expo-router';
import { BackButton } from '@/src/components/ui/BackButton';
import { Colors } from '@/constants/theme';
import { callApi } from '@/src/services/api';
import { useAppConfig } from '@/src/services/appSettings';
import { emitToast } from '@/src/lib/toastBridge';
import { reportError } from '@/src/lib/reportError';

/**
 * Report a Problem.
 *
 * The Settings row for this was a dead button, which in a user-generated-content
 * app is a real gap: there was no in-app way to raise anything with the team, and
 * the backend's support-ticket table had no client writing to it.
 */

const CATEGORIES = [
  { key: 'bug', label: 'Something is broken' },
  { key: 'payment', label: 'Payment or coins' },
  { key: 'contest', label: 'Contest or voting' },
  { key: 'account', label: 'Account or login' },
  { key: 'content', label: 'Abusive content or user' },
  { key: 'other', label: 'Something else' },
] as const;

export default function ReportProblemScreen() {
  const router = useRouter();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const textColor = isDark ? '#fff' : '#212121';
  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;
  const secondary = isDark ? '#A0A0A0' : '#666';
  const inputBg = isDark ? '#1F222A' : '#FAFAFA';
  const border = isDark ? '#35383F' : '#EEEEEE';

  const { config } = useAppConfig();
  const supportEmail = (config as any)?.supportEmail || '';

  const [category, setCategory] = useState<string>('bug');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const canSubmit = message.trim().length >= 10 && !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const label = CATEGORIES.find((c) => c.key === category)?.label ?? category;
      await callApi('createSupportTicket', {
        subject: `[${category}] ${label}`,
        message: message.trim(),
      });
      setSubmitted(true);
      emitToast('Thanks — your report has been sent.', 'success');
    } catch (e: any) {
      reportError(e, { screen: 'report-problem' });
      emitToast(e?.message || 'Could not send your report. Please try again.', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor }]}>
        <View style={styles.header}>
          <BackButton size={24} color={textColor} style={styles.backButton} />
          <Text style={[styles.headerTitle, { color: textColor }]}>Report sent</Text>
        </View>
        <View style={styles.centered}>
          <Text style={[styles.successTitle, { color: textColor }]}>We&apos;ve got it</Text>
          <Text style={[styles.body, { color: secondary, textAlign: 'center' }]}>
            Our team will look into this. If we need more detail we&apos;ll get in touch
            {supportEmail ? ` at ${supportEmail}` : ''}.
          </Text>
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={() => router.back()}
            accessibilityRole="button"
            accessibilityLabel="Done"
          >
            <Text style={styles.primaryBtnText}>Done</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]}>
      <View style={styles.header}>
        <BackButton size={24} color={textColor} style={styles.backButton} />
        <Text style={[styles.headerTitle, { color: textColor }]}>Report a Problem</Text>
      </View>

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={[styles.label, { color: textColor }]}>What is this about?</Text>
        <View style={styles.chips}>
          {CATEGORIES.map((c) => {
            const active = category === c.key;
            return (
              <TouchableOpacity
                key={c.key}
                onPress={() => setCategory(c.key)}
                style={[
                  styles.chip,
                  { borderColor: active ? '#FF4D67' : border, backgroundColor: active ? '#FF4D67' : inputBg },
                ]}
                accessibilityRole="radio"
                accessibilityState={{ selected: active }}
                accessibilityLabel={c.label}
              >
                <Text style={[styles.chipText, { color: active ? '#fff' : textColor }]}>{c.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <Text style={[styles.label, { color: textColor, marginTop: 24 }]}>Tell us what happened</Text>
        <TextInput
          value={message}
          onChangeText={setMessage}
          multiline
          numberOfLines={8}
          maxLength={2000}
          textAlignVertical="top"
          placeholder="The more detail the better — what you did, what you expected, and what happened instead."
          placeholderTextColor={secondary}
          style={[styles.input, { backgroundColor: inputBg, borderColor: border, color: textColor }]}
          accessibilityLabel="Describe the problem"
        />
        <Text style={[styles.hint, { color: secondary }]}>
          {message.trim().length < 10
            ? 'Please add a little more detail (at least 10 characters).'
            : `${message.length}/2000`}
        </Text>

        <TouchableOpacity
          style={[styles.primaryBtn, !canSubmit && styles.primaryBtnDisabled]}
          onPress={submit}
          disabled={!canSubmit}
          accessibilityRole="button"
          accessibilityLabel="Send report"
        >
          {submitting ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.primaryBtnText}>Send report</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => router.push('/legal/guidelines')}
          accessibilityRole="link"
          accessibilityLabel="Read the community guidelines"
        >
          <Text style={[styles.link, { color: '#FF4D67' }]}>Read our community guidelines</Text>
        </TouchableOpacity>

        {!!supportEmail && (
          <TouchableOpacity
            onPress={() => Linking.openURL(`mailto:${supportEmail}`)}
            accessibilityRole="link"
            accessibilityLabel={`Email support at ${supportEmail}`}
          >
            <Text style={[styles.link, { color: secondary }]}>Or email {supportEmail}</Text>
          </TouchableOpacity>
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
  content: { paddingHorizontal: 20, paddingBottom: 40 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  successTitle: { fontSize: 22, fontFamily: 'Urbanist-Bold', marginBottom: 10 },
  label: { fontSize: 16, fontFamily: 'Urbanist-Bold', marginBottom: 12 },
  body: { fontSize: 15, lineHeight: 22, fontFamily: 'Urbanist-Regular' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 100, borderWidth: 1 },
  chipText: { fontSize: 14, fontFamily: 'Urbanist-SemiBold' },
  input: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    minHeight: 160,
    fontSize: 15,
    fontFamily: 'Urbanist-Regular',
  },
  hint: { fontSize: 12, fontFamily: 'Urbanist-Regular', marginTop: 8 },
  primaryBtn: {
    backgroundColor: '#FF4D67',
    borderRadius: 100,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 24,
  },
  primaryBtnDisabled: { opacity: 0.5 },
  primaryBtnText: { color: '#fff', fontSize: 16, fontFamily: 'Urbanist-Bold' },
  link: { fontSize: 14, fontFamily: 'Urbanist-SemiBold', textAlign: 'center', marginTop: 18 },
});
