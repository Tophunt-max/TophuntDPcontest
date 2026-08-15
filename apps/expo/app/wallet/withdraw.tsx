import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TextInput, TouchableOpacity, ScrollView, Alert, ActivityIndicator, useColorScheme } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@/src/lib/icons';
import * as Haptics from 'expo-haptics';

import { useAuth } from '@/src/services/auth';
import { Colors } from '@/constants/theme';
import { useProfile } from '@/src/hooks/useProfileData';
import { walletService } from '@/src/services/wallet/walletService';
import { useAppConfig } from '@/src/services/appSettings';
import { readApi } from '@/src/services/api';

const METHODS = [
  { key: 'upi', label: 'UPI', placeholder: 'yourname@upi' },
  { key: 'bank', label: 'Bank', placeholder: 'Account no. / IFSC' },
  { key: 'paytm', label: 'Paytm', placeholder: 'Paytm number' },
];

export default function WithdrawScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const { data: profile, refetch } = useProfile(user?.uid || '');
  const { config } = useAppConfig();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';

  const backgroundColor = isDark ? Colors.dark.background : '#F8F9FA';
  const cardBg = isDark ? '#1F222A' : '#FFFFFF';
  const textColor = isDark ? Colors.dark.text : '#121212';
  const subTextColor = isDark ? '#A0A0A0' : '#757575';
  const primaryColor = '#FF4D67';

  const wcfg = config?.withdrawal || {};
  const enabled = wcfg.enabled !== false;
  const minAmount = Number(wcfg.minAmount ?? 0);
  const rate = Number(wcfg.conversionRate ?? 1);

  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('upi');
  const [account, setAccount] = useState('');
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState<any[]>([]);

  const balance = Number(profile?.Dpcoin || 0);
  const amt = Number(amount) || 0;
  const cash = amt * rate;

  const loadHistory = async () => {
    try {
      const rows = await readApi('/read/withdrawals');
      setHistory(Array.isArray(rows) ? rows : []);
    } catch {
      /* ignore */
    }
  };
  useEffect(() => { loadHistory(); }, []);

  const submit = async () => {
    if (!enabled) return;
    if (!Number.isInteger(amt) || amt <= 0) return Alert.alert('Invalid amount', 'Enter a valid whole number of coins.');
    if (amt < minAmount) return Alert.alert('Below minimum', `Minimum withdrawal is ${minAmount} coins.`);
    if (amt > balance) return Alert.alert('Insufficient balance', 'You do not have enough coins.');
    if (!account.trim()) return Alert.alert('Account required', 'Enter your payout account details.');

    setLoading(true);
    try {
      await walletService.requestWithdrawal(amt, method, account.trim());
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert('Request submitted', 'Your payout request is pending admin approval.');
      setAmount(''); setAccount('');
      refetch();
      loadHistory();
    } catch (e: any) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Could not submit', e?.message || 'Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const statusColor = (s: string) =>
    s === 'approved' ? '#4CAF50' : s === 'paid' ? '#2196F3' : s === 'rejected' ? '#FF4D67' : '#FF9800';

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}><Ionicons name="chevron-back" size={28} color={textColor} /></TouchableOpacity>
        <Text style={[styles.title, { color: textColor }]}>Withdraw</Text>
        <View style={{ width: 28 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
        {!enabled ? (
          <View style={[styles.card, { backgroundColor: cardBg, alignItems: 'center' }]}>
            <Ionicons name="lock-closed-outline" size={40} color={subTextColor} />
            <Text style={[styles.disabledText, { color: subTextColor }]}>Withdrawals are currently disabled. Please check back later.</Text>
          </View>
        ) : (
          <>
            <View style={[styles.card, { backgroundColor: cardBg }]}>
              <Text style={[styles.label, { color: subTextColor }]}>Available balance</Text>
              <Text style={[styles.balance, { color: textColor }]}>{balance} <Text style={{ fontSize: 16, color: subTextColor }}>coins</Text></Text>
              <Text style={[styles.hint, { color: subTextColor }]}>Min {minAmount} coins • Rate ₹{rate}/coin</Text>
            </View>

            <View style={[styles.card, { backgroundColor: cardBg }]}>
              <Text style={[styles.label, { color: subTextColor }]}>Amount (coins)</Text>
              <TextInput
                value={amount}
                onChangeText={setAmount}
                keyboardType="number-pad"
                placeholder="0"
                placeholderTextColor={subTextColor}
                style={[styles.input, { color: textColor, borderColor: isDark ? '#35383F' : '#EEE' }]}
              />
              {amt > 0 && <Text style={[styles.cashPreview, { color: primaryColor }]}>You'll receive ≈ ₹{cash.toFixed(2)}</Text>}

              <Text style={[styles.label, { color: subTextColor, marginTop: 16 }]}>Method</Text>
              <View style={styles.methodRow}>
                {METHODS.map((m) => (
                  <TouchableOpacity
                    key={m.key}
                    onPress={() => setMethod(m.key)}
                    style={[styles.methodChip, { backgroundColor: method === m.key ? primaryColor : (isDark ? '#2A2D35' : '#ECECEC') }]}
                  >
                    <Text style={{ color: method === m.key ? '#FFF' : subTextColor, fontFamily: 'Urbanist-Bold', fontSize: 13 }}>{m.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={[styles.label, { color: subTextColor, marginTop: 16 }]}>Account details</Text>
              <TextInput
                value={account}
                onChangeText={setAccount}
                placeholder={METHODS.find((m) => m.key === method)?.placeholder}
                placeholderTextColor={subTextColor}
                style={[styles.input, { color: textColor, borderColor: isDark ? '#35383F' : '#EEE' }]}
              />

              <TouchableOpacity style={[styles.submitBtn, { backgroundColor: primaryColor, opacity: loading ? 0.7 : 1 }]} onPress={submit} disabled={loading}>
                {loading ? <ActivityIndicator color="#FFF" /> : <Text style={styles.submitText}>Request Payout</Text>}
              </TouchableOpacity>
            </View>
          </>
        )}

        {/* History */}
        <Text style={[styles.sectionTitle, { color: textColor }]}>Your Requests</Text>
        {history.length === 0 ? (
          <Text style={[styles.hint, { color: subTextColor, textAlign: 'center', marginTop: 10 }]}>No withdrawal requests yet</Text>
        ) : (
          history.map((w) => (
            <View key={w.id} style={[styles.historyItem, { backgroundColor: cardBg }]}>
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                  <Text style={[styles.histAmount, { color: textColor }]}>{w.amount} coins</Text>
                  <Ionicons name="arrow-forward" size={13} color={subTextColor} />
                  <Text style={[styles.histAmount, { color: textColor }]}>₹{Number(w.cashAmount || 0).toFixed(2)}</Text>
                </View>
                <Text style={[styles.hint, { color: subTextColor }]}>{String(w.method || '').toUpperCase()}</Text>
              </View>
              <View style={[styles.statusPill, { backgroundColor: statusColor(w.status) + '22' }]}>
                <Text style={{ color: statusColor(w.status), fontFamily: 'Urbanist-Bold', fontSize: 12 }}>{w.status}</Text>
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
  balance: { fontSize: 32, fontFamily: 'Urbanist-Bold' },
  hint: { fontSize: 12, fontFamily: 'Urbanist-Medium', marginTop: 4 },
  input: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, fontFamily: 'Urbanist-Bold' },
  cashPreview: { fontSize: 14, fontFamily: 'Urbanist-Bold', marginTop: 8 },
  methodRow: { flexDirection: 'row', gap: 10 },
  methodChip: { paddingHorizontal: 18, paddingVertical: 10, borderRadius: 14 },
  submitBtn: { marginTop: 20, paddingVertical: 15, borderRadius: 16, alignItems: 'center' },
  submitText: { color: '#FFF', fontFamily: 'Urbanist-Bold', fontSize: 16 },
  disabledText: { textAlign: 'center', fontFamily: 'Urbanist-Medium', fontSize: 15, marginTop: 12, lineHeight: 22 },
  sectionTitle: { fontSize: 18, fontFamily: 'Urbanist-Bold', marginTop: 8, marginBottom: 12 },
  historyItem: { flexDirection: 'row', alignItems: 'center', borderRadius: 16, padding: 16, marginBottom: 10 },
  histAmount: { fontSize: 15, fontFamily: 'Urbanist-Bold' },
  statusPill: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20 },
});
