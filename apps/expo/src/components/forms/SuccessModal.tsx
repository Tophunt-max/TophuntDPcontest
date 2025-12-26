import React from 'react';
import { View, Text, StyleSheet, Dimensions, TouchableOpacity } from 'react-native';
import { Success } from '@/assets/svgs'; // Ensure this SVG exists or use a fallback

const { width } = Dimensions.get('window');

interface SuccessModalProps {
  visible?: boolean; // Can be used for conditional rendering if not routing based
  onGoHome: () => void;
}

export const SuccessModal: React.FC<SuccessModalProps> = ({ onGoHome }) => {
  return (
    <View style={styles.overlay}>
      <View style={styles.card}>
        <View style={styles.iconContainer}>
            <Success width={150} height={150} />
        </View>
        <Text style={styles.title}>Congratulations!</Text>
        <Text style={styles.subtitle}>Your account is ready to use</Text>
        <TouchableOpacity style={styles.button} onPress={onGoHome}>
          <Text style={styles.buttonText}>Go to Homepage</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 1000,
  },
  card: {
    width: width * 0.8,
    backgroundColor: '#fff',
    borderRadius: 40,
    padding: 32,
    alignItems: 'center',
  },
  iconContainer: {
    marginBottom: 24,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#FF4D67',
    marginBottom: 12,
  },
  subtitle: {
    fontSize: 16,
    color: '#212121',
    marginBottom: 32,
    textAlign: 'center',
  },
  button: {
    width: '100%',
    backgroundColor: '#FF4D67',
    paddingVertical: 16,
    borderRadius: 30,
    alignItems: 'center',
    shadowColor: '#FF4D67',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
});
