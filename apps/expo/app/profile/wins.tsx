import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  FlatList,
  ActivityIndicator,
} from 'react-native';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@/src/lib/icons';
import { BackButton } from '@/src/components/ui/BackButton';
import { useAuth } from '@/src/hooks/useAuth';
import { useUserWins } from '@/src/hooks/useProfileData';
import { PostCard } from '@/src/components/home/PostCard';
import { Colors } from '@/constants/theme';

export default function WinsScreen() {

  const { user } = useAuth();
  const params = useLocalSearchParams();
  const userId = (params.userId as string) || user?.uid || '';

  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;
  const textColor = isDark ? Colors.dark.text : Colors.light.text;
  const subTextColor = isDark ? '#9BA1A6' : '#616161';

  const { data: wins, isLoading, refetch, isRefetching } = useUserWins(userId);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]}>
      <View style={[styles.header, { borderBottomColor: isDark ? '#23262D' : '#EEF0F4' }]}>
        <BackButton size={24} color={textColor} style={styles.backBtn} />
        <View style={styles.titleWrap}>
          <Ionicons name="trophy" size={16} color="#FFD700" />
          <Text style={[styles.title, { color: textColor }]}>Wins</Text>
        </View>
        <View style={styles.backBtn} />
      </View>

      {isLoading ? (
        <View style={styles.center}><ActivityIndicator size="large" color="#FF4D67" /></View>
      ) : (
        <FlatList
          data={wins ?? []}
          keyExtractor={(item: any) => item.id}
          renderItem={({ item }) => <PostCard item={item} isDark={isDark} />}
          refreshing={isRefetching}
          onRefresh={refetch}
          contentContainerStyle={{ paddingVertical: 8, paddingBottom: 40 }}
          showsVerticalScrollIndicator={false}
          removeClippedSubviews
          initialNumToRender={4}
          maxToRenderPerBatch={5}
          windowSize={7}
          ListEmptyComponent={
            <View style={styles.center}>
              <Ionicons name="trophy-outline" size={40} color={subTextColor} />
              <Text style={[styles.emptyText, { color: subTextColor }]}>No wins yet. Win a battle to see it here!</Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  titleWrap: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  title: { fontFamily: 'Urbanist-Bold', fontSize: 18 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80, gap: 12 },
  emptyText: { fontFamily: 'Urbanist-Medium', fontSize: 14, textAlign: 'center', paddingHorizontal: 40 },
});
