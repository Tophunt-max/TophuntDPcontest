import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Modal } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { Ionicons } from '@/src/lib/icons';
import { useDesignWindow } from '@/src/lib/layout';

const NoInternetModal = () => {
  const [isConnected, setIsConnected] = useState<boolean | null>(true);
  // Design width, not window width: a Modal covers the whole browser, but the
  // card should stay phone-sized on desktop.
  const { width } = useDesignWindow();

  useEffect(() => {
    // Subscribe to network state changes
    const unsubscribe = NetInfo.addEventListener(state => {
      setIsConnected(state.isConnected);
    });

    return () => {
      unsubscribe();
    };
  }, []);

  if (isConnected === null || isConnected) return null;

  return (
    <Modal
      transparent
      animationType="fade"
      visible={!isConnected}
      statusBarTranslucent
    >
      <View style={styles.overlay}>
        <View style={[styles.content, { width: width * 0.8 }]}>
          <Ionicons name="cloud-offline-outline" size={60} color="#ff4466" />
          <Text style={styles.title}>No Internet Connection</Text>
          <Text style={styles.message}>
            Please check your internet connection and try again.
          </Text>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  content: {
    backgroundColor: 'white',
    padding: 30,
    borderRadius: 20,
    alignItems: 'center',
  },
  title: {
    fontSize: 20,
    fontWeight: 'bold',
    marginTop: 20,
    color: '#000',
    textAlign: 'center',
  },
  message: {
    fontSize: 16,
    color: '#666',
    marginTop: 10,
    textAlign: 'center',
  },
});

export default NoInternetModal;
