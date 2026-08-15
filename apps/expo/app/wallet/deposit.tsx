import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TextInput, TouchableOpacity, ScrollView, Alert, ActivityIndicator, Image, useColorScheme } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@/src/lib/icons';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import * as ImagePicker from 'expo-image-picker';
import { uploadToS3 } from '@/src/lib/uploadToS3';

import { Colors } from '@/constants/theme';
import { walletService } from '@/src/services/wallet/walletService';
import { useAppConfig } from '@/src/services/appSettings';
import { readApi } from '@/src/services/api';

export default function DepositScreen() {
  const router = useRouter();
  const { config } = useAppConfig();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';

  const backgroundColor = isDark ? Colors.dark.background : '#F8F9FA';
  const cardBg = isDark ? '#1F222A' : '#FFFFFF';
  const textColor = isDark ? Colors.dark.text : '#121212';
  const subTextColor = isDark ? '#A0A0A0' : '#757575';
  const primaryColor = '#FF4D67';

  const gw = config?.paymentGateway || {};
  const mode = gw.mode || 'auto';
  const manualEnabled = mode === 'manual' || mode === 'both';
  const rate = Number(gw.coinRate ?? 1);

  const [amount, setAmount] = useState('');
  const [utr, setUtr] = useState('');
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState<any[]>([]);
  const [shot, setShot] = useState('');
  const [uploading, setUploading] = useState(false);

  const amt = Number(amount) || 0;
  const payInr = amt * rate;

  const loadHistory = async () => {
    try {
      const res: any = await readApi('/read/deposits');
      setHistory(res?.deposits || []);
    } catch {
      /* ignore */
    }
  };
  useEffect(() => { loadHistory(); }, []);

  const copy = async (v?: string) => {
    if (!v) return;
    await Clipboard.setStringAsync(v);
    Alert.alert('Copied', v);
  };

  const pickScreenshot = async () => {
    try {
      const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.6 });
      if (res.canceled || !res.assets?.[0]?.uri) return;
      setUploading(true);
      const url = await uploadToS3(res.assets[0].uri, 'image/jpeg', 'deposits');
      setShot(url);
    } catch (e: any) {
      Alert.alert('Upload failed', e?.message || 'Could not upload screenshot.');
    } finally {
      setUploading(false);
    }
  };

  const submit = async () => {
    if (!Number.isInteger(amt) || amt <= 0) return Alert.alert('Invalid amount', 'Enter a valid whole number of coins.');
    if (!utr.trim() || utr.trim().length < 4) return Alert.alert('UTR required', 'Enter the bank UTR / transaction reference from your payment.');
    setLoading(true);
    try {
      await walletService.requestDeposit(amt, utr.trim(), 'qr', shot || undefined);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert('Submitted', 'Your deposit is pending admin approval. Coins will be added once verified.');
      setAmount(''); setUtr(''); setShot('');
      loadHistory();
    } catch (e: any) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Could not submit', e?.message || 'Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const statusColor = (s: string) =>
    s === 'approved' ? '#4CAF50' : s === 'rejected' ? '#FF4D67' : '#FF9800';

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}><Ionicons name="chevron-back" size={28} color={textColor} /></TouchableOpacity>
        <Text style={[styles.title, { color: textColor }]}>Add Money</Text>
        <View style={{ width: 28 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
        {!manualEnabled ? (
          <View style={[styles.card, { backgroundColor: cardBg, alignItems: 'center' }]}>
            <Ionicons name="card-outline" size={40} color={subTextColor} />
            <Text style={[styles.disabledText, { color: subTextColor }]}>Manual QR deposits are not enabled. Please use the in-app store to buy coins.</Text>
            <TouchableOpacity style={[styles.submitBtn, { backgroundColor: primaryColor, marginTop: 16 }]} onPress={() => router.replace('/wallet/store')}>
              <Text style={styles.submitText}>Open Coin Store</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            {/* QR + UPI */}
            <View style={[styles.card, { backgroundColor: cardBg, alignItems: 'center' }]}>
              <Text style={[styles.label, { color: subTextColor, marginBottom: 12 }]}>Scan & pay to this QR</Text>
              {gw.qrImageUrl ? (
                <Image source={{ uri: gw.qrImageUrl }} style={styles.qr} resizeMode="contain" />
              ) : (
                <View style={[styles.qr, { alignItems: 'center', justifyContent: 'center', backgroundColor: '#EEE' }]}>
                  <Ionicons name="qr-code-outline" size={48} color="#999" />
                </View>
              )}
              {gw.upiId ? (
                <TouchableOpacity style={styles.upiRow} onPress={() => copy(gw.upiId)}>
                  <Text style={[styles.upiText, { color: textColor }]}>{gw.upiId}</Text>
                  <Ionicons name="copy-outline" size={16} color={primaryColor} />
                </TouchableOpacity>
              ) : null}
              {gw.note ? <Text style={[styles.note, { color: subTextColor }]}>{gw.note}</Text> : null}
            </View>

            {/* Amount + UTR */}
            <View style={[styles.card, { backgroundColor: cardBg }]}>
              <Text style={[styles.label, { color: subTextColor }]}>Coins to add</Text>
              <TextInput
                value={amount}
                onChangeText={setAmount}
                keyboardType="number-pad"
                placeholder="0"
                placeholderTextColor={subTextColor}
                style={[styles.input, { color: textColor, borderColor: isDark ? '#35383F' : '#EEE' }]}
              />
              {amt > 0 && <Text style={[styles.cashPreview, { color: primaryColor }]}>Pay ₹{payInr.toFixed(2)} (₹{rate}/coin)</Text>}

              <Text style={[styles.label, { color: subTextColor, marginTop: 16 }]}>UTR / Transaction reference</Text>
              <TextInput
                value={utr}
                onChangeText={setUtr}
                placeholder="e.g. 3210 9876 5432"
                placeholderTextColor={subTextColor}
                autoCapitalize="characters"
                style={[styles.input, { color: textColor, borderColor: isDark ? '#35383F' : '#EEE' }]}
              />
              <Text style={[styles.note, { color: subTextColor, marginTop: 6 }]}>Pay first, then paste the UTR from your bank/UPI app.</Text>

              <TouchableOpacity style={[styles.uploadBtn, { borderColor: isDark ? '#35383F' : '#DDD' }]} onPress={pickScreenshot} disabled={uploading}>
                {uploading ? (
                  <ActivityIndicator color={primaryColor} />
                ) : shot ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Image source={{ uri: shot }} style={{ width: 32, height: 32, borderRadius: 6 }} />
                    <Text style={{ color: '#4CAF50', fontFamily: 'Urbanist-Bold', fontSize: 13 }}>Screenshot attached</Text>
                    <Ionicons name="checkmark-circle" size={16} color="#4CAF50" />
                  </View>
                ) : (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Ionicons name="image-outline" size={18} color={subTextColor} />
                    <Text style={{ color: subTextColor, fontFamily: 'Urbanist-Medium', fontSize: 13 }}>Attach payment screenshot (optional)</Text>
                  </View>
                )}
              </TouchableOpacity>

              <TouchableOpacity style={[styles.submitBtn, { backgroundColor: primaryColor, opacity: loading ? 0.7 : 1 }]} onPress={submit} disabled={loading}>
                {loading ? <ActivityIndicator color="#FFF" /> : <Text style={styles.submitText}>Submit Deposit</Text>}
              </TouchableOpacity>
            </View>

            {mode === 'both' && (
              <TouchableOpacity onPress={() => router.replace('/wallet/store')} style={{ marginBottom: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                <Text style={{ color: primaryColor, textAlign: 'center', fontFamily: 'Urbanist-Bold' }}>Or pay instantly by card / UPI</Text>
                <Ionicons name="arrow-forward" size={16} color={primaryColor} />
              </TouchableOpacity>
            )}
          </>
        )}

        {/* History */}
        <Text style={[styles.sectionTitle, { color: textColor }]}>Your Deposits</Text>
        {history.length === 0 ? (
          <Text style={[styles.note, { color: subTextColor, textAlign: 'center', marginTop: 10 }]}>No deposit requests yet</Text>
        ) : (
          history.map((d) => (
            <View key={d.id} style={[styles.historyItem, { backgroundColor: cardBg }]}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.histAmount, { color: textColor }]}>{d.amount} coins • ₹{Number(d.payAmount || 0).toFixed(2)}</Text>
                <Text style={[styles.note, { color: subTextColor }]}>UTR {d.utr}</Text>
              </View>
              <View style={[styles.statusPill, { backgroundColor: statusColor(d.status) + '22' }]}>
                <Text style={{ color: statusColor(d.status), fontFamily: 'Urbanist-Bold', fontSize: 12 }}>{d.status}</Text>
              </View>
            </View>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 10 },
  title: { fontSize: 20, fontFamily: 'Urbanist-Bold' },
  card: { borderRadius: 20, padding: 20, marginBottom: 16 },
  label: { fontSize: 13, fontFamily: 'Urbanist-Medium', marginBottom: 6 },
  qr: { width: 200, height: 200, borderRadius: 16, backgroundColor: '#FFF' },
  upiRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 14, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 12, backgroundColor: 'rgba(255,77,103,0.1)' },
  upiText: { fontSize: 15, fontFamily: 'Urbanist-Bold' },
  note: { fontSize: 12, fontFamily: 'Urbanist-Medium', marginTop: 8, textAlign: 'center' },
  input: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, fontFamily: 'Urbanist-Bold' },
  cashPreview: { fontSize: 14, fontFamily: 'Urbanist-Bold', marginTop: 8 },
  uploadBtn: { marginTop: 14, paddingVertical: 12, borderRadius: 14, borderWidth: 1, borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center' },
  submitBtn: { marginTop: 20, paddingVertical: 15, borderRadius: 16, alignItems: 'center' },
  submitText: { color: '#FFF', fontFamily: 'Urbanist-Bold', fontSize: 16 },
  disabledText: { textAlign: 'center', fontFamily: 'Urbanist-Medium', fontSize: 15, marginTop: 12, lineHeight: 22 },
  sectionTitle: { fontSize: 18, fontFamily: 'Urbanist-Bold', marginTop: 8, marginBottom: 12 },
  historyItem: { flexDirection: 'row', alignItems: 'center', borderRadius: 16, padding: 16, marginBottom: 10 },
  histAmount: { fontSize: 15, fontFamily: 'Urbanist-Bold' },
  statusPill: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20 },
});
