import React from 'react';
import { View, Text, StyleSheet, SafeAreaView, ScrollView, Pressable } from 'react-native';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { BackButton } from '@/src/components/ui/BackButton';
import { Ionicons } from '@/src/lib/icons';
import { Colors } from '@/constants/theme';
import { setDataSaverMode, useNetworkQuality } from '@/src/lib/networkQuality';
import { describeConnection, type DataSaverMode } from '@/src/lib/imageQuality';

/**
 * Settings › Data saver — Instagram's "Use less mobile data".
 *
 * When it applies, photos load in the lighter 320 size instead of 1080 and
 * nothing is preloaded. The app also does this on its own on a slow (2G/3G)
 * connection or when the phone/browser has its own data saver on; this screen
 * says which one is in effect right now.
 */
const OPTIONS: { mode: DataSaverMode; title: string; description: string }[] = [
  { mode: 'off', title: 'Off', description: 'Full-quality photos. Lighter photos only on a slow connection.' },
  { mode: 'cellular', title: 'On mobile data', description: 'Lighter photos and no preloading on mobile data. Full quality on Wi-Fi.' },
  { mode: 'always', title: 'Always', description: 'Lighter photos and no preloading on every connection.' },
];

export default function DataSaverScreen() {
  const isDark = useColorScheme() === 'dark';
  const textColor = isDark ? '#fff' : '#212121';
  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;
  const secondary = isDark ? '#A0A0A0' : '#666';
  const card = isDark ? '#1F222A' : '#FFFFFF';
  const border = isDark ? '#35383F' : '#EEEEEE';
  const { mode, net, policy } = useNetworkQuality();

  const status =
    policy.reason === 'data_saver'
      ? 'Data saver is on: photos load in the lighter size.'
      : policy.reason === 'system_data_saver'
        ? "Your device's data saver is on, so photos load in the lighter size."
        : policy.reason === 'slow_network'
          ? 'Slow connection: photos load in the lighter size so they appear faster.'
          : 'Photos load in full quality.';

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]}>
      <View style={styles.header}>
        <BackButton size={24} color={textColor} style={styles.backButton} />
        <Text style={[styles.headerTitle, { color: textColor }]}>Data saver</Text>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.lead, { color: secondary }]}>
          Use less data by loading lighter photos and not preloading stories. Photos stay sharp enough to see clearly;
          they are just not full resolution.
        </Text>

        <View style={[styles.card, { backgroundColor: card, borderColor: border }]} accessibilityRole="radiogroup">
          {OPTIONS.map((o, i) => {
            const on = o.mode === mode;
            return (
              <Pressable
                key={o.mode}
                onPress={() => void setDataSaverMode(o.mode)}
                style={[styles.option, i < OPTIONS.length - 1 && { borderBottomWidth: 1, borderBottomColor: border }]}
                accessibilityRole="radio"
                accessibilityState={{ checked: on }}
                accessibilityLabel={o.title}
                accessibilityHint={o.description}
              >
                <Ionicons name={on ? 'radio-button-on' : 'radio-button-off'} size={22} color={on ? '#FF4D67' : secondary} />
                <View style={styles.optionText}>
                  <Text style={[styles.optionTitle, { color: textColor }]}>{o.title}</Text>
                  <Text style={[styles.optionDesc, { color: secondary }]}>{o.description}</Text>
                </View>
              </Pressable>
            );
          })}
        </View>

        <View style={[styles.status, { backgroundColor: card, borderColor: border }]}>
          <Ionicons name="information-circle-outline" size={20} color={secondary} />
          <View style={styles.optionText}>
            <Text style={[styles.statusTitle, { color: textColor }]}>Now: {describeConnection(net)}</Text>
            <Text style={[styles.optionDesc, { color: secondary }]}>{status}</Text>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', height: 56, paddingHorizontal: 16 },
  backButton: { marginRight: 12 },
  headerTitle: { fontSize: 20, fontFamily: 'Urbanist-Bold' },
  content: { padding: 16, paddingBottom: 40, gap: 16 },
  lead: { fontSize: 14, fontFamily: 'Urbanist-Regular', lineHeight: 20 },
  card: { borderRadius: 16, borderWidth: 1, overflow: 'hidden' },
  option: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16, paddingVertical: 14 },
  optionText: { flex: 1 },
  optionTitle: { fontSize: 15, fontFamily: 'Urbanist-Bold' },
  optionDesc: { fontSize: 13, fontFamily: 'Urbanist-Regular', marginTop: 2, lineHeight: 18 },
  status: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, padding: 16, borderRadius: 16, borderWidth: 1 },
  statusTitle: { fontSize: 14, fontFamily: 'Urbanist-SemiBold' },
});
