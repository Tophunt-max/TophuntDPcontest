import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { Ionicons } from '@expo/vector-icons';
import { emitToast } from '@/src/lib/toastBridge';

/**
 * Shows a slim persistent bar while the device is offline AND fires a centered
 * popup toast on every connectivity change (offline / back online). Rendered
 * once at the root so it overlays every screen. Pairs with React Query's
 * onlineManager (wired in _layout) which pauses/refetches on the same signal.
 */
export function OfflineBanner() {
  const [offline, setOffline] = useState(false);
  // Last known connectivity (null = unknown). Used to detect real transitions
  // so we don't toast on cold start.
  const prevConnected = useRef<boolean | null>(null);

  useEffect(() => {
    const unsub = NetInfo.addEventListener((state) => {
      const connected = state.isConnected;
      // `isConnected` is null until the first probe — ignore unknown states.
      if (connected === null || connected === undefined) return;

      if (prevConnected.current !== null && connected !== prevConnected.current) {
        if (connected) {
          emitToast('Back online', 'success');
        } else {
          emitToast("You're offline. Check your connection.", 'error');
        }
      }
      prevConnected.current = connected;
      setOffline(connected === false);
    });
    return () => unsub();
  }, []);

  if (!offline) return null;

  return (
    <View style={styles.banner} pointerEvents="none">
      <Ionicons name="cloud-offline-outline" size={16} color="#FFF" style={{ marginRight: 8 }} />
      <Text style={styles.text}>No internet connection</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#1F222A',
    paddingVertical: 10,
    paddingBottom: 24,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10000,
  },
  text: {
    color: '#FFF',
    fontSize: 13,
    fontFamily: 'Urbanist-Bold',
  },
});
