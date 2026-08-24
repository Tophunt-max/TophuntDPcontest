import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, SafeAreaView, ActivityIndicator, Linking, TouchableOpacity } from 'react-native';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { BackButton } from '@/src/components/ui/BackButton';
import { Colors } from '@/constants/theme';
import { readApi, poll } from '@/src/services/api';

/**
 * Renders a legal document served from admin App Settings.
 *
 * Shared by every legal screen so there is one place that handles loading,
 * emptiness and failure. Previously each screen duplicated this and rendered
 * "No content available." on a fetch failure — indistinguishable from a genuinely
 * empty policy, and an app-store reviewer seeing that has grounds to reject.
 */
export type LegalDocKey =
  | 'privacyPolicy'
  | 'termsOfService'
  | 'refundPolicy'
  | 'communityGuidelines';

interface Props {
  docKey: LegalDocKey;
  title: string;
  /** Shown when the admin has not published this document yet. */
  emptyMessage?: string;
}

export function LegalDocument({ docKey, title, emptyMessage }: Props) {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const textColor = isDark ? '#fff' : '#212121';
  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;
  const secondaryTextColor = isDark ? '#A0A0A0' : '#666';

  const [content, setContent] = useState('');
  const [supportEmail, setSupportEmail] = useState('');
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const unsubscribe = poll<any>(
      () => readApi('/read/app-config'),
      (data) => {
        setContent(data?.legalContent?.[docKey] || '');
        setSupportEmail(data?.supportEmail || '');
        setFailed(false);
        setLoading(false);
      },
      60000,
      () => {
        // Distinguish "could not load" from "not published": the first is
        // retryable and the user should know to check their connection.
        setFailed(true);
        setLoading(false);
      },
    );
    return () => unsubscribe();
  }, [docKey]);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]}>
      <View style={styles.header}>
        <BackButton size={24} color={textColor} style={styles.backButton} />
        <Text style={[styles.headerTitle, { color: textColor }]} numberOfLines={1}>
          {title}
        </Text>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent}>
        {loading ? (
          <ActivityIndicator size="large" color="#FF4D67" style={{ marginTop: 50 }} />
        ) : failed && !content ? (
          <Text style={[styles.content, { color: secondaryTextColor }]}>
            {`We couldn't load this document. Please check your connection — it will retry automatically.`}
          </Text>
        ) : content ? (
          <Text style={[styles.content, { color: secondaryTextColor }]}>{content}</Text>
        ) : (
          <View>
            <Text style={[styles.content, { color: secondaryTextColor }]}>
              {emptyMessage || `Our ${title.toLowerCase()} has not been published yet.`}
            </Text>
            {!!supportEmail && (
              <TouchableOpacity
                onPress={() => Linking.openURL(`mailto:${supportEmail}`)}
                accessibilityRole="link"
                accessibilityLabel={`Email support at ${supportEmail}`}
              >
                <Text style={[styles.link, { color: '#FF4D67' }]}>Contact {supportEmail}</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 15,
  },
  backButton: { marginRight: 15 },
  headerTitle: { fontSize: 24, fontFamily: 'Urbanist-Bold', flex: 1 },
  scrollContent: { paddingHorizontal: 20, paddingBottom: 40 },
  content: { fontSize: 15, lineHeight: 24, fontFamily: 'Urbanist-Regular' },
  link: { fontSize: 15, fontFamily: 'Urbanist-SemiBold', marginTop: 16 },
});
