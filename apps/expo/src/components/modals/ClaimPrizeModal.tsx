import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Alert
} from 'react-native';
import { ReanimatedBottomSheet } from './ReanimatedBottomSheet';
import { callApi } from '@/src/services/api';
import { useThemeColor } from '@/hooks/use-theme-color';
import { Trophy_Icon } from '@/assets/svgs';

interface ClaimPrizeModalProps {
  visible: boolean;
  onClose: () => void;
  matchId: string;
  prizeName: string;
}

export const ClaimPrizeModal: React.FC<ClaimPrizeModalProps> = ({ visible, onClose, matchId, prizeName }) => {
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
    fullName: '',
    phone: '',
    address: '',
    city: '',
    state: '',
    pincode: ''
  });

  const textColor = useThemeColor({}, 'text');
  const inputBg = useThemeColor({ light: '#F5F5F5', dark: '#2A2D35' }, 'background');

  const handleSubmit = async () => {
    if (!formData.fullName || !formData.phone || !formData.address || !formData.pincode) {
      Alert.alert("Error", "Please fill all required fields.");
      return;
    }

    setLoading(true);
    try {
      const res: any = await callApi('claimPrize', {
        matchId,
        shippingInfo: formData
      });

      if (res.success) {
        Alert.alert("Success! 🎉", "Your shipping details have been saved. Admin will process your prize soon!");
        onClose();
      }
    } catch (error: any) {
      Alert.alert("Failed", error.message || "Could not submit claim.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <ReanimatedBottomSheet visible={visible} onClose={onClose} title="Claim Your Prize" maxHeight={650}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView style={styles.scrollContainer} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          
          <View style={styles.prizeCard}>
              <Trophy_Icon width={40} height={40} color="#FFD700" />
              <View style={styles.prizeInfo}>
                  <Text style={styles.prizeLabel}>You've won:</Text>
                  <Text style={styles.prizeTitle}>{prizeName}</Text>
              </View>
          </View>

          <Text style={[styles.sectionTitle, { color: textColor }]}>Shipping Address</Text>
          
          <TextInput
            style={[styles.input, { backgroundColor: inputBg, color: textColor }]}
            placeholder="Receiver Full Name"
            placeholderTextColor="#888"
            value={formData.fullName}
            onChangeText={(t) => setFormData({ ...formData, fullName: t })}
          />

          <TextInput
            style={[styles.input, { backgroundColor: inputBg, color: textColor }]}
            placeholder="Mobile Number"
            placeholderTextColor="#888"
            keyboardType="phone-pad"
            value={formData.phone}
            onChangeText={(t) => setFormData({ ...formData, phone: t })}
          />

          <TextInput
            style={[styles.input, styles.textArea, { backgroundColor: inputBg, color: textColor }]}
            placeholder="Full Address (House No, Street, Landmark)"
            placeholderTextColor="#888"
            multiline
            numberOfLines={3}
            value={formData.address}
            onChangeText={(t) => setFormData({ ...formData, address: t })}
          />

          <View style={styles.row}>
              <TextInput
                style={[styles.input, { flex: 1, backgroundColor: inputBg, color: textColor }]}
                placeholder="City"
                placeholderTextColor="#888"
                value={formData.city}
                onChangeText={(t) => setFormData({ ...formData, city: t })}
              />
              <TextInput
                style={[styles.input, { flex: 1, backgroundColor: inputBg, color: textColor, marginLeft: 10 }]}
                placeholder="Pincode"
                placeholderTextColor="#888"
                keyboardType="number-pad"
                value={formData.pincode}
                onChangeText={(t) => setFormData({ ...formData, pincode: t })}
              />
          </View>

          <TextInput
            style={[styles.input, { backgroundColor: inputBg, color: textColor }]}
            placeholder="State"
            placeholderTextColor="#888"
            value={formData.state}
            onChangeText={(t) => setFormData({ ...formData, state: t })}
          />

          <TouchableOpacity 
            onPress={handleSubmit} 
            disabled={loading}
            style={[styles.submitBtn, { backgroundColor: '#FF4D67' }]}
          >
            {loading ? <ActivityIndicator color="#FFF" /> : <Text style={styles.submitText}>Submit Shipping Details</Text>}
          </TouchableOpacity>

          <Text style={styles.helperText}>* Admin will verify and ship your product within 3-5 working days.</Text>
          <View style={{ height: 40 }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </ReanimatedBottomSheet>
  );
};

const styles = StyleSheet.create({
  scrollContainer: { paddingHorizontal: 20 },
  prizeCard: { 
    flexDirection: 'row', 
    alignItems: 'center', 
    backgroundColor: 'rgba(255, 215, 0, 0.1)', 
    padding: 16, 
    borderRadius: 16, 
    marginBottom: 24,
    borderWidth: 1,
    borderColor: 'rgba(255, 215, 0, 0.3)'
  },
  prizeInfo: { marginLeft: 15 },
  prizeLabel: { fontSize: 12, color: '#B8860B', fontFamily: 'Urbanist-Medium' },
  prizeTitle: { fontSize: 18, color: '#8B6508', fontFamily: 'Urbanist-Bold' },
  sectionTitle: { fontSize: 16, fontFamily: 'Urbanist-Bold', marginBottom: 15 },
  input: { height: 56, borderRadius: 12, paddingHorizontal: 16, marginBottom: 12, fontSize: 15, fontFamily: 'Urbanist-Medium' },
  textArea: { height: 100, textAlignVertical: 'top', paddingTop: 16 },
  row: { flexDirection: 'row' },
  submitBtn: { height: 56, borderRadius: 28, justifyContent: 'center', alignItems: 'center', marginTop: 10, shadowColor: '#FF4D67', shadowOpacity: 0.2, shadowRadius: 10, elevation: 5 },
  submitText: { color: '#FFF', fontSize: 16, fontFamily: 'Urbanist-Bold' },
  helperText: { fontSize: 11, color: '#888', marginTop: 15, textAlign: 'center', fontFamily: 'Urbanist-Medium' }
});
