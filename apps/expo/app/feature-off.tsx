import React, { useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { Colors } from '@/constants/theme';
import { Ionicons } from '@/src/lib/icons';
import { useAppConfig } from '@/src/services/appSettings';
import { featureOn, type FeatureKey } from '@/src/lib/appControl';
import { PHONE_MAX_WIDTH } from '@/src/lib/layout';
import { useAuth } from '@/src/hooks/useAuth';

const LABEL: Record<FeatureKey, string> = {
  contests: 'Contests',
  chat: 'Chat',
  stories: 'Stories',
  topups: 'Coin top-up',
  withdrawals: 'Withdrawals',
  posts: 'Posts',
};

/**
 * Where a link into a feature the admin switched off lands (App Control →
 * Feature Flags). Leaves by itself the moment the feature is switched back on.
 */
export default function FeatureOffScreen() {
  const { f } = useLocalSearchParams<{ f?: string }>();
  const key = (f && f in LABEL ? f : 'contests') as FeatureKey;
  const router = useRouter();
  const { config } = useAppConfig();
  const isDark = useColorScheme() === 'dark';
  const textColor = isDark ? Colors.dark.text : Colors.light.text;
  const sub = isDark ? '#BDBDBD' : '#616161';
  // Only once the config is known: "no config yet" must not read as "back on".
  const { user } = useAuth();
  const enabled = !!config && featureOn(config, key, user?.uid ?? null);

  useEffect(() => {
    if (enabled) {
      if (router.canGoBack()) router.back();
      else router.replace('/');
    }
  }, [enabled, router]);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: isDark ? Colors.dark.background : Colors.light.background }]}>
      <View style={styles.content}>
        <Ionicons name="time-outline" size={72} color="#FF4D67" />
        <Text style={[styles.title, { color: textColor }]}>{LABEL[key]} abhi band hai</Text>
        <Text style={[styles.body, { color: sub }]}>
          Hum is feature par kaam kar rahe hain. Jaise hi ye wapas aayega, ye screen apne aap hat jaayegi.
        </Text>
        <TouchableOpacity style={styles.btn} onPress={() => router.replace('/')} accessibilityRole="button">
          <Text style={styles.btnText}>Home par jao</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, width: '100%', maxWidth: PHONE_MAX_WIDTH, alignSelf: 'center' },
  title: { fontFamily: 'Urbanist-Bold', fontSize: 22, marginTop: 16, textAlign: 'center' },
  body: { fontFamily: 'Urbanist-Medium', fontSize: 15, marginTop: 8, textAlign: 'center', lineHeight: 21 },
  btn: { backgroundColor: '#FF4D67', borderRadius: 26, paddingHorizontal: 28, paddingVertical: 14, marginTop: 24 },
  btnText: { color: '#FFF', fontFamily: 'Urbanist-Bold', fontSize: 16 },
});
