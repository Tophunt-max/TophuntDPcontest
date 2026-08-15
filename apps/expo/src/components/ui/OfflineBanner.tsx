import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { Ionicons } from '@expo/vector-icons';

/**
 * A slim bar that appears whenever the device loses connectivity. Rendered once
 * at the root so it overlays every screen. Pairs with React Query's
 * onlineManager (wired in _layout) which pauses/refetches based on the same
 * NetInfo signal.
 */
export function OfflineBanner() {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const unsub = NetInfo.addEventListener((state) => {
      // `isConnected` is null until the first probe — treat only an explicit
      // `false` as offline to avoid a flash on cold start.
      setOffline(state.isConnected === false);
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
