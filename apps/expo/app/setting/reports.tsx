import React from 'react';
import { View, Text, StyleSheet, SafeAreaView, FlatList, TouchableOpacity, ActivityIndicator, RefreshControl } from 'react-native';
import { useRouter } from 'expo-router';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { BackButton } from '@/src/components/ui/BackButton';
import { Ionicons } from '@/src/lib/icons';
import { Colors } from '@/constants/theme';
import { useMyReports } from '@/src/hooks/useProfileData';
import type { MyReport, MyReportStatus } from '@/src/services/users';

/**
 * The signed-in user's moderation reports and what happened to each one
 * (GET /read/me/reports). A report is "In review" until a moderator acts; then
 * "Action taken" (the content was removed) or "No violation found". The
 * reporter is notified on each outcome (`report_update`), which opens here.
 *
 * Deliberately shows nothing about the reported account beyond a link, and
 * nothing about other reporters.
 */

const STATUS: Record<MyReportStatus, { label: string; color: string; icon: string }> = {
  open: { label: 'In review', color: '#F59E0B', icon: 'time-outline' },
  actioned: { label: 'Action taken', color: '#22C55E', icon: 'checkmark-circle-outline' },
  dismissed: { label: 'No violation found', color: '#64748B', icon: 'information-circle-outline' },
};

const NOUN: Record<string, string> = { battle: 'Battle', account: 'Account', comment: 'Comment', post: 'Post', story: 'Story' };

/** "scam: Scam or fraud — extra" -> "Scam or fraud — extra"; "other: text" -> "text". */
export function reasonLabel(reason: string | null): string {
  const r = (reason || '').trim();
  if (!r) return 'No reason given';
  const m = r.match(/^[a-z_]+:\s*(.*)$/);
  const text = m ? m[1] : r;
  return text || 'Something else';
}

function formatDate(ms: number | null): string {
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return '';
  }
}

export default function MyReportsScreen() {
  const router = useRouter();
  const isDark = useColorScheme() === 'dark';
  const textColor = isDark ? '#fff' : '#212121';
  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;
  const secondary = isDark ? '#A0A0A0' : '#666';
  const border = isDark ? '#35383F' : '#EEEEEE';

  const { data, isLoading, refetch, isRefetching } = useMyReports();
  const items = data || [];

  const open = (r: MyReport) => {
    if (!r.targetId) return;
    if (r.targetType === 'battle') router.push(`/battle/${encodeURIComponent(r.targetId)}` as any);
    else if (r.targetType === 'account') router.push({ pathname: '/profile', params: { userId: r.targetId } } as any);
  };

  const renderItem = ({ item }: { item: MyReport }) => {
    const s = STATUS[item.status] ?? STATUS.open;
    const linkable = !!item.targetId && (item.targetType === 'battle' || item.targetType === 'account');
    return (
      <TouchableOpacity
        style={[styles.row, { borderBottomColor: border }]}
        onPress={() => open(item)}
        disabled={!linkable}
        activeOpacity={0.7}
        accessibilityRole={linkable ? 'button' : undefined}
        accessibilityLabel={`${NOUN[item.targetType] ?? 'Content'} report, ${s.label}`}
      >
        <View style={styles.rowText}>
          <Text style={[styles.rowTitle, { color: textColor }]}>
            {NOUN[item.targetType] ?? 'Content'} · {formatDate(item.createdAt)}
          </Text>
          <Text style={[styles.rowReason, { color: secondary }]} numberOfLines={2}>
            {reasonLabel(item.reason)}
          </Text>
          {!!item.resolvedAt && (
            <Text style={[styles.rowMeta, { color: secondary }]}>Reviewed {formatDate(item.resolvedAt)}</Text>
          )}
        </View>
        <View style={[styles.statusPill, { backgroundColor: `${s.color}22` }]}>
          <Ionicons name={s.icon as any} size={14} color={s.color} />
          <Text style={[styles.statusText, { color: s.color }]}>{s.label}</Text>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]}>
      <View style={styles.header}>
        <BackButton size={24} color={textColor} style={styles.backButton} />
        <Text style={[styles.headerTitle, { color: textColor }]}>My reports</Text>
      </View>
      {isLoading && !data ? (
        <View style={styles.center}>
          <ActivityIndicator color="#FF4D67" />
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(r) => r.id}
          renderItem={renderItem}
          contentContainerStyle={items.length ? styles.content : styles.emptyContent}
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor="#FF4D67" colors={['#FF4D67']} />
          }
          ListHeaderComponent={
            items.length ? (
              <Text style={[styles.hint, { color: secondary }]}>
                Reports are anonymous. We tell you when a moderator has reviewed one.
              </Text>
            ) : null
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="shield-checkmark-outline" size={40} color={secondary} />
              <Text style={[styles.emptyTitle, { color: textColor }]}>No reports</Text>
              <Text style={[styles.emptyText, { color: secondary }]}>
                When you report an account, battle or comment, you can follow its status here.
              </Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', height: 56, paddingHorizontal: 16 },
  backButton: { marginRight: 12 },
  headerTitle: { fontSize: 20, fontFamily: 'Urbanist-Bold' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  content: { paddingBottom: 40 },
  emptyContent: { flexGrow: 1 },
  hint: { fontSize: 12, fontFamily: 'Urbanist-Regular', paddingHorizontal: 20, paddingTop: 8, paddingBottom: 4, lineHeight: 17 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1 },
  rowText: { flex: 1 },
  rowTitle: { fontSize: 15, fontFamily: 'Urbanist-Bold' },
  rowReason: { fontSize: 13, fontFamily: 'Urbanist-Regular', marginTop: 2 },
  rowMeta: { fontSize: 11, fontFamily: 'Urbanist-Regular', marginTop: 4 },
  statusPill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 12 },
  statusText: { fontSize: 12, fontFamily: 'Urbanist-Bold' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40, gap: 8 },
  emptyTitle: { fontSize: 18, fontFamily: 'Urbanist-Bold', marginTop: 6 },
  emptyText: { fontSize: 14, fontFamily: 'Urbanist-Regular', textAlign: 'center', lineHeight: 20 },
});
