import React, { useEffect } from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useAuth } from '@/src/hooks/useAuth';
import { savePendingInvite } from '@/src/services/referrals';

/**
 * `tophunt.in/invite/<CODE>` — a friend's invite link.
 *
 * The code is remembered on this device (src/services/referrals.ts) and pre-fills
 * the referral field at signup, so the friend never has to type it. A visitor who
 * is already signed in goes to Refer & Earn, where a new account can still apply
 * it within the program's apply window.
 */
export default function InviteScreen() {
  const { code } = useLocalSearchParams<{ code?: string }>();
  const router = useRouter();
  const { user, loading } = useAuth();

  useEffect(() => {
    if (loading) return;
    let cancelled = false;
    (async () => {
      if (typeof code === 'string' && code) await savePendingInvite(code);
      if (cancelled) return;
      router.replace((user ? '/referral' : '/auth/signup') as any);
    })();
    return () => {
      cancelled = true;
    };
  }, [code, user, loading]);

  return (
    <View style={styles.wrap}>
      <ActivityIndicator color="#FF4D67" />
      <Text style={styles.text}>Invite khol rahe hain…</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  text: { fontFamily: 'Urbanist-Medium', color: '#666' },
});
