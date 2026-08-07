import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, SafeAreaView, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { Left_Arrow } from '@/assets/svgs';
import { Colors } from '@/constants/theme';
import { useColorScheme } from 'react-native';
import { readApi, poll } from '@/src/services/api';

export default function TermsOfServiceScreen() {
  const router = useRouter();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const textColor = isDark ? '#fff' : '#212121';
  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;
  const secondaryTextColor = isDark ? '#A0A0A0' : '#666';

  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = poll<any>(
      () => readApi("/read/app-config"),
      (data) => {
        if (data?.legalContent?.termsOfService) setContent(data.legalContent.termsOfService);
        setLoading(false);
      },
      60000,
    );
    return () => unsubscribe();
  }, []);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <Left_Arrow width={24} height={24} color={textColor} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: textColor }]}>Terms of Service</Text>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent}>
        {loading ? (
          <ActivityIndicator size="large" color="#FF4D67" style={{ marginTop: 50 }} />
        ) : (
          <Text style={[styles.content, { color: secondaryTextColor }]}>
            {content || "No terms of service content available."}
          </Text>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 15,
  },
  backButton: {
    marginRight: 15,
  },
  headerTitle: {
    fontSize: 24,
    fontFamily: 'Urbanist-Bold',
  },
  scrollContent: {
    padding: 20,
  },
  content: {
    fontSize: 16,
    fontFamily: 'Urbanist-Regular',
    lineHeight: 24,
    whiteSpace: 'pre-wrap',
  },
});
