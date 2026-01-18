import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, useColorScheme } from 'react-native';
import { useRouter } from 'expo-router';
import { Colors } from '@/constants/theme';
import { Inbox_Light, Inbox_Dark } from '@/assets/svgs';

export const EmptyMessages: React.FC = () => {
  const router = useRouter();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const textColor = isDark ? Colors.dark.text : Colors.light.text;

  return (
    <View style={styles.emptyContainer}>
      <View style={styles.emptyIconCircle}>
         {isDark ? <Inbox_Dark width={60} height={60} /> : <Inbox_Light width={60} height={60} />}
      </View>
      <Text style={[styles.emptyTitle, { color: textColor }]}>No messages yet</Text>
      <TouchableOpacity style={styles.startChatButton} onPress={() => router.push('/explore')}>
          <Text style={styles.startChatButtonText}>Explore Friends</Text>
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  emptyContainer: { alignItems: 'center', justifyContent: 'center', paddingVertical: 60 },
  emptyIconCircle: { width: 120, height: 120, borderRadius: 60, backgroundColor: 'rgba(255, 77, 103, 0.1)', justifyContent: 'center', alignItems: 'center', marginBottom: 20 },
  emptyTitle: { fontSize: 22, fontWeight: '700', marginBottom: 20 },
  startChatButton: { backgroundColor: '#FF4D67', paddingHorizontal: 30, paddingVertical: 15, borderRadius: 30 },
  startChatButtonText: { color: 'white', fontSize: 16, fontWeight: '700' },
});
