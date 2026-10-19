import React, { useMemo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform, Linking } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@/src/lib/icons';
import { detectInAppBrowser, externalBrowserUrl } from '@/src/lib/inAppBrowser';
import { useToast } from '@/src/components/toast/ToastProvider';

/**
 * Shown on the login / signup screens when the page was opened inside another
 * app's browser (Instagram, Facebook, …), where Google sign-in cannot work.
 * Android gets a one-tap "open in Chrome"; iOS copies the link (there is no
 * reliable way to leave a webview from inside it). Web only; renders nothing
 * elsewhere.
 */
export function InAppBrowserNotice({ isDark }: { isDark: boolean }) {
  const { addToast } = useToast();
  const info = useMemo(
    () => (Platform.OS === 'web' && typeof navigator !== 'undefined' ? detectInAppBrowser(navigator.userAgent) : null),
    [],
  );
  if (!info?.inApp) return null;

  const pageUrl = typeof window !== 'undefined' ? window.location.href : 'https://tophunt.in/auth/login';
  const intent = externalBrowserUrl(pageUrl, info);

  const onPress = async () => {
    if (intent) {
      try {
        window.location.href = intent;
        return;
      } catch {
        // fall through to copy
      }
    }
    try {
      await Clipboard.setStringAsync(pageUrl);
      addToast('Link copy ho gaya — Safari/Chrome mein paste karke kholo', 'success');
    } catch {
      Linking.openURL(pageUrl).catch(() => {});
    }
  };

  return (
    <View
      style={[styles.box, { backgroundColor: isDark ? '#2A2410' : '#FFF8DB', borderColor: isDark ? '#5C4A12' : '#FFE08A' }]}
      accessibilityRole="alert"
    >
      <Ionicons name="alert-circle-outline" size={20} color="#B07800" />
      <View style={styles.textWrap}>
        <Text style={[styles.title, { color: isDark ? '#FFE68A' : '#5A3A00' }]}>
          {info.name ? `${info.name} ke andar khula hai` : 'App ke andar wala browser'}
        </Text>
        <Text style={[styles.body, { color: isDark ? '#E8D9A8' : '#7A5A10' }]}>
          Google login yahan kaam nahi karta. Best experience ke liye {info.os === 'ios' ? 'Safari' : 'Chrome'} mein kholo, ya Phone se login karo.
        </Text>
        <TouchableOpacity onPress={onPress} accessibilityRole="button" style={styles.btn}>
          <Text style={styles.btnText}>{intent ? 'Chrome mein kholo' : 'Link copy karo'}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { flexDirection: 'row', gap: 10, borderWidth: 1, borderRadius: 14, padding: 12, width: '100%', marginBottom: 16 },
  textWrap: { flex: 1, minWidth: 0 },
  title: { fontFamily: 'Urbanist-Bold', fontSize: 14 },
  body: { fontFamily: 'Urbanist-Medium', fontSize: 13, marginTop: 2, lineHeight: 18 },
  btn: { alignSelf: 'flex-start', backgroundColor: '#FF4D67', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 7, marginTop: 8 },
  btnText: { color: '#FFF', fontFamily: 'Urbanist-Bold', fontSize: 13 },
});

export default InAppBrowserNotice;
