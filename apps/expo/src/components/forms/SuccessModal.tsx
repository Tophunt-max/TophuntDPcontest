import React from 'react';
import { View, Text, StyleSheet, Dimensions, TouchableOpacity, ActivityIndicator } from 'react-native';
import { Success } from '@/assets/svgs'; 
import { Ionicons } from '@/src/lib/icons';

const { width } = Dimensions.get('window');

interface SuccessModalProps {
  visible?: boolean; 
  onGoHome: () => void;
  title?: string;
  subtitle?: string;
  onShare?: () => void;
  shareLoading?: boolean;
}

export const SuccessModal: React.FC<SuccessModalProps> = ({ 
  onGoHome, 
  title = "Congratulations!", 
  subtitle = "Your account is ready to use",
  onShare,
  shareLoading = false
}) => {
  return (
    <View style={styles.overlay}>
      <View style={styles.card}>
        <View style={styles.iconContainer}>
            <Success width={150} height={150} />
        </View>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.subtitle}>{subtitle}</Text>
        
        <TouchableOpacity style={styles.button} onPress={onGoHome}>
          <Text style={styles.buttonText}>Go to Homepage</Text>
        </TouchableOpacity>

        {onShare && (
            <TouchableOpacity style={[styles.secondaryButton]} onPress={onShare} disabled={shareLoading}>
                {shareLoading ? (
                    <ActivityIndicator size="small" color="#FF4D67" />
                ) : (
                    <>
                        <Ionicons name="share-social-outline" size={20} color="#FF4D67" style={{marginRight: 8}} />
                        <Text style={styles.secondaryButtonText}>Share with Friends</Text>
                    </>
                )}
            </TouchableOpacity>
        )}
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
    width: width * 0.85,
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
    textAlign: 'center',
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
    marginBottom: 12,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
  secondaryButton: {
    width: '100%',
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 14,
    borderRadius: 30,
    borderWidth: 1,
    borderColor: '#FF4D67',
    backgroundColor: '#FFF0F3',
  },
  secondaryButtonText: {
    color: '#FF4D67',
    fontSize: 16,
    fontWeight: 'bold',
  },
});
