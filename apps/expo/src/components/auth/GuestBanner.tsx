import React, { memo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useGlobalSearchParams, usePathname, useRouter, useSegments } from 'expo-router';
import { useAuthGate } from '@/src/hooks/useAuthGate';
import { loginHref, pathWithQuery, signupHref } from '@/src/lib/authGate';

/**
 * The persistent "Log in / Sign up" strip a guest sees above the bottom
 * navigation (Instagram web's bottom bar). Rendered by `BottomNav`, so every
 * screen that has the nav gets it; renders nothing once signed in.
 *
 * Both buttons carry the current screen as the return path, so signing in from
 * a battle or a profile lands back on it.
 */
const GuestBannerComponent = ({ isDark }: { isDark: boolean }) => {
  const { isGuest } = useAuthGate();
  const router = useRouter();
  const pathname = usePathname();
  const params = useGlobalSearchParams();
  const segments = useSegments();
  if (!isGuest) return null;

  const back = pathWithQuery(pathname, params as Record<string, unknown>, segments as string[]);
  return (
    <View
      style={[
        styles.bar,
        { backgroundColor: isDark ? '#181A20' : '#FFF5F7', borderTopColor: isDark ? '#262A35' : '#FFD6DE' },
      ]}
      accessibilityRole="toolbar"
    >
      <Text style={[styles.text, { color: isDark ? '#E0E0E0' : '#212121' }]} numberOfLines={2}>
        Vote, follow and battle on TopHunt
      </Text>
      <TouchableOpacity
        style={[styles.button, styles.login, { borderColor: isDark ? '#35383F' : '#FF4D67' }]}
        onPress={() => router.push(loginHref(back) as any)}
        accessibilityRole="button"
        accessibilityLabel="Log in"
      >
        <Text style={[styles.buttonText, { color: isDark ? '#FFF' : '#FF4D67' }]}>Log in</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.button, styles.signup]}
        onPress={() => router.push(signupHref(back) as any)}
        accessibilityRole="button"
        accessibilityLabel="Sign up"
      >
        <Text style={[styles.buttonText, { color: '#FFF' }]}>Sign up</Text>
      </TouchableOpacity>
    </View>
  );
};

export const GuestBanner = memo(GuestBannerComponent);

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: 1,
    gap: 8,
  },
  text: { flex: 1, fontFamily: 'Urbanist-SemiBold', fontSize: 13 },
  button: { minHeight: 36, paddingHorizontal: 14, borderRadius: 18, justifyContent: 'center' },
  login: { borderWidth: 1 },
  signup: { backgroundColor: '#FF4D67' },
  buttonText: { fontFamily: 'Urbanist-Bold', fontSize: 13 },
});

export default GuestBanner;
