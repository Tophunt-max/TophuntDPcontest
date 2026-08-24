// Web-safe stub or alternative implementation
// Since react-native-image-viewing doesn't support web, we can either:
// 1. Return a stub component that does nothing
// 2. Use a web-friendly lightbox library (optional enhancement)
// For now, we'll provide a minimal working stub to unblock the build.

import React from 'react';
import { Modal, View, Image, StyleSheet, TouchableOpacity, Text } from 'react-native';
import { CloseIcon } from '@/src/components/ui/CloseIcon';

// Simple web-compatible lightbox implementation
export const ImageViewer = ({ 
  visible, 
  images, 
  imageIndex = 0, 
  onRequestClose 
}: { 
  visible: boolean; 
  images: { uri: string }[]; 
  imageIndex?: number; 
  onRequestClose: () => void; 
}) => {
  if (!visible) return null;

  const currentImage = images[imageIndex];

  return (
    <Modal visible={visible} transparent={true} onRequestClose={onRequestClose}>
      <View style={styles.container}>
        <TouchableOpacity
          style={styles.closeButton}
          onPress={onRequestClose}
          accessibilityRole="button"
          accessibilityLabel="Close image"
        >
           <CloseIcon size={30} color="white" />
        </TouchableOpacity>
        
        <View style={styles.imageContainer}>
          {currentImage && (
             <Image 
               source={{ uri: currentImage.uri }} 
               style={styles.image} 
               resizeMode="contain" 
             />
          )}
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.9)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  closeButton: {
    position: 'absolute',
    top: 40,
    right: 20,
    zIndex: 1,
    padding: 10,
  },
  imageContainer: {
    width: '100%',
    height: '80%',
    justifyContent: 'center',
    alignItems: 'center',
  },
  image: {
    width: '100%',
    height: '100%',
  },
});
