import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { SplashVisual } from '@/src/components/system/SplashVisual';
import { STARTUP_SLOW_HINT_MS, startupHint } from '@/src/lib/startupHint';

/** Calm status for the restoring splash: offline at once, slow after a few seconds. */
function useStartupHint(): string | null {
  const [slow, setSlow] = useState(false);
  const [connected, setConnected] = useState<boolean | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), STARTUP_SLOW_HINT_MS);
    const off = NetInfo.addEventListener((s) => setConnected(s.isConnected ?? null));
    return () => {
      clearTimeout(t);
      off();
    };
  }, []);
  return startupHint(slow, connected);
}

function RestoringSplash() {
  return <SplashVisual hint={useStartupHint()} />;
}

/**
 * First paint while Firebase restores persistence.
 *
 * Uses the canonical OLD splash visual — not a separate “session restore” screen —
 * so the Instagram-style auth gate fixes guest flicker without changing the
 * design the user already knows. A slow or missing connection only adds a calm
 * status line (Firebase keeps the saved login and finishes on its own). The
 * Retry / Continue as guest controls appear only if restore truly hangs past
 * Firebase's own network timeout (services/authSession.ts watchdog).
 */
export function AuthStartupGate({
  failed = false,
  onRetry,
  onContinue,
}: {
  failed?: boolean;
  onRetry?: () => void;
  onContinue?: () => void;
}) {
  const dark = useColorScheme() === 'dark';
  const sub = dark ? '#A0A0A0' : '#666';

  if (!failed) return <RestoringSplash />;

  return (
    <SplashVisual
      loading={false}
      footer={
        <View style={styles.actions}>
          <Text style={[styles.message, { color: sub }]}>Saved session restore nahi ho paya.</Text>
          <TouchableOpacity style={styles.primary} onPress={onRetry} accessibilityRole="button">
            <Text style={styles.primaryText}>Retry</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.secondary} onPress={onContinue} accessibilityRole="button">
            <Text style={[styles.secondaryText, { color: sub }]}>Continue as guest</Text>
          </TouchableOpacity>
          <Text style={[styles.note, { color: sub }]}>Aapka saved login delete nahi kiya gaya.</Text>
        </View>
      }
    />
  );
}

const styles = StyleSheet.create({
  actions: { width: '100%', maxWidth: 320, alignItems: 'center' },
  message: { fontFamily: 'Urbanist-Medium', fontSize: 13, textAlign: 'center', marginBottom: 12 },
  primary: { width: '100%', height: 46, borderRadius: 23, backgroundColor: '#FF4D67', alignItems: 'center', justifyContent: 'center' },
  primaryText: { color: '#FFF', fontFamily: 'Urbanist-Bold', fontSize: 16 },
  secondary: { height: 42, alignItems: 'center', justifyContent: 'center', marginTop: 6, paddingHorizontal: 16 },
  secondaryText: { fontFamily: 'Urbanist-SemiBold', fontSize: 14 },
  note: { fontFamily: 'Urbanist-Regular', fontSize: 11, textAlign: 'center', marginTop: 2 },
});
