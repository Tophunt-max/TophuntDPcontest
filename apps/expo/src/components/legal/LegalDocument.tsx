import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, SafeAreaView, ActivityIndicator, Linking, TouchableOpacity } from 'react-native';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { BackButton } from '@/src/components/ui/BackButton';
import { Colors } from '@/constants/theme';
import { readApi } from '@/src/services/api';
import { LegalMarkdown } from './LegalMarkdown';

/**
 * Renders a legal document served from admin App Settings.
 *
 * Shared by every legal screen so there is one place that handles loading,
 * emptiness and failure. Previously each screen duplicated this and rendered
 * "No content available." on a fetch failure — indistinguishable from a genuinely
 * empty policy, and an app-store reviewer seeing that has grounds to reject.
 *
 * ## The "not published yet" branch is now a fallback, not a normal state
 *
 * `/read/app-config` used to project `legalContent` straight out of the admin
 * config, so a document nobody had typed arrived as `""` and this component
 * rendered "Our terms of service has not been published yet." That was live on
 * tophunt.in for terms, privacy and refund simultaneously.
 *
 * The Worker now falls back to documents bundled in its own source
 * (`apps/worker/src/content/legal.ts`), so in practice `content` is always
 * non-empty. The empty branch is kept deliberately: it is the only sane thing to
 * show if a future config ever does return blank text, and deleting it would
 * substitute a blank screen for an explanation.
 *
 * ## Fetched once, from a dedicated endpoint
 *
 * This used to `poll('/read/app-config')` every 60 seconds. Both halves of that
 * were wrong. `app-config` is the app-wide config endpoint, so putting ~28 KB of
 * legal text in it taxed every client for content only these four screens read —
 * hence `/read/legal`. And polling a document that changes a few times a year is
 * pointless: nobody is reading a privacy policy at the moment it is amended, and
 * `poll` cannot be given a long interval without also making its failure retry
 * that slow.
 *
 * So: fetch once, and retry only on failure, backing off to a cap.
 *
 * Content is rendered through `LegalMarkdown` rather than a bare `<Text>`,
 * because these documents carry headings and bullets and the previous single-Text
 * render displayed the markup literally.
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
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const load = async () => {
      try {
        const data: any = await readApi('/read/legal');
        if (cancelled) return;
        setContent(data?.legalContent?.[docKey] || '');
        setSupportEmail(data?.supportEmail || '');
        setFailed(false);
        setLoading(false);
      } catch {
        if (cancelled) return;
        // Distinguish "could not load" from "not published": the first is
        // retryable and the user should know to check their connection. The copy
        // promises an automatic retry, so there has to be one.
        setFailed(true);
        setLoading(false);
        attempt += 1;
        const delay = Math.min(2000 * 2 ** (attempt - 1), 30000);
        timer = setTimeout(load, delay);
      }
    };

    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
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
          <LegalMarkdown
            content={content}
            color={secondaryTextColor}
            headingColor={textColor}
            accentColor="#FF4D67"
          />
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
