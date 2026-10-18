import React, { useCallback, useState } from 'react';
import { View, FlatList, StyleSheet, Text, TouchableOpacity, RefreshControl, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useRouter } from 'expo-router';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { Colors } from '@/constants/theme';
import { BackButton } from '@/src/components/ui/BackButton';
import { Avatar } from '@/src/components/ui/Avatar';
import { VerifiedBadge } from '@/src/components/ui/VerifiedBadge';
import { Ionicons } from '@/src/lib/icons';
import { emitToast } from '@/src/lib/toastBridge';
import { useFollowRequests, useRespondFollowRequest } from '@/src/hooks/useProfileData';
import type { FollowRequest } from '@/src/services/users';

/**
 * Follow requests — the owner of a PRIVATE account confirms or deletes each
 * pending request (Instagram's "Follow requests" screen). Requires an account
 * (unlisted in src/lib/routeAccess.ts, so private by default), and the Worker
 * only ever returns the signed-in user's own requests.
 *
 * Confirm makes the requester a follower and tells them; Delete removes the
 * request silently. Both are idempotent server-side, so a double tap is safe.
 */
export default function FollowRequestsScreen() {
  const router = useRouter();
  const isDark = useColorScheme() === 'dark';
  const bg = isDark ? Colors.dark.background : Colors.light.background;
  const textColor = isDark ? Colors.dark.text : Colors.light.text;
  const sub = isDark ? '#A0A0A0' : '#666';
  const border = isDark ? '#2A2D35' : '#EEE';

  const { data, isLoading, isError, refetch, isRefetching, fetchNextPage, hasNextPage, isFetchingNextPage } = useFollowRequests();
  const respond = useRespondFollowRequest();
  // Rows answered in this session disappear at once; the refetch confirms it.
  const [answered, setAnswered] = useState<Record<string, 'confirmed' | 'deleted'>>({});

  const answer = useCallback(
    (req: FollowRequest, accept: boolean) => {
      setAnswered((a) => ({ ...a, [req.id]: accept ? 'confirmed' : 'deleted' }));
      respond.mutate(
        { requesterId: req.id, accept },
        {
          onSuccess: (res: any) => {
            // `accepted: false` on a Confirm: there was nothing left to confirm
            // (they withdrew it, or another device already answered).
            if (accept && !res?.accepted) {
              setAnswered((a) => ({ ...a, [req.id]: 'deleted' }));
              emitToast('This request is no longer pending.', 'info');
            }
          },
          onError: (e: any) => {
            // Refused because of a block: the server has already removed the
            // request, so drop the row rather than offering it again.
            // ApiCallError codes look like `functions/permission-denied`.
            if (String(e?.code ?? '').endsWith('permission-denied')) {
              setAnswered((a) => ({ ...a, [req.id]: 'deleted' }));
              emitToast("This request isn't available any more.", 'info');
              return;
            }
            setAnswered((a) => {
              const next = { ...a };
              delete next[req.id];
              return next;
            });
            emitToast('Could not update the request. Try again.', 'error');
          },
        },
      );
    },
    [respond],
  );

  const rows = (data?.pages ?? []).flatMap((p) => p.items).filter((r) => answered[r.id] !== 'deleted');

  const renderItem = ({ item }: { item: FollowRequest }) => {
    const confirmed = answered[item.id] === 'confirmed';
    return (
      <View style={styles.row}>
        <TouchableOpacity
          style={styles.who}
          onPress={() => router.push(`/profile?userId=${encodeURIComponent(item.id)}` as any)}
          accessibilityRole="button"
          accessibilityLabel={`Open @${item.username}'s profile`}
        >
          <Avatar uri={item.profileImageUrlThumb || item.profileImageUrl || undefined} name={item.fullName || item.username} size={48} />
          <View style={styles.names}>
            <View style={styles.nameRow}>
              <Text style={[styles.username, { color: textColor }]} numberOfLines={1}>
                {item.username}
              </Text>
              <VerifiedBadge verified={item.verified} size={14} />
            </View>
            {item.fullName ? (
              <Text style={[styles.fullName, { color: sub }]} numberOfLines={1}>
                {item.fullName}
              </Text>
            ) : null}
          </View>
        </TouchableOpacity>
        {confirmed ? (
          <Text style={[styles.done, { color: sub }]}>Confirmed</Text>
        ) : (
          <View style={styles.actions}>
            <TouchableOpacity
              style={[styles.btn, styles.confirm]}
              onPress={() => answer(item, true)}
              accessibilityRole="button"
              accessibilityLabel={`Confirm @${item.username}`}
            >
              <Text style={styles.confirmText}>Confirm</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.btn, { backgroundColor: isDark ? '#2A2D35' : '#EFEFEF' }]}
              onPress={() => answer(item, false)}
              accessibilityRole="button"
              accessibilityLabel={`Delete @${item.username}'s request`}
            >
              <Text style={[styles.deleteText, { color: textColor }]}>Delete</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    );
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: bg }]} edges={['top', 'left', 'right']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={[styles.header, { borderBottomColor: border }]}>
        <BackButton size={24} color={textColor} />
        <Text style={[styles.title, { color: textColor }]}>Follow requests</Text>
      </View>
      {isLoading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color="#FF4D67" />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.id}
          renderItem={renderItem}
          refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => refetch()} tintColor={textColor} />}
          contentContainerStyle={{ paddingVertical: 8, flexGrow: 1 }}
          onEndReached={() => {
            if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
          }}
          onEndReachedThreshold={0.4}
          ListFooterComponent={isFetchingNextPage ? <ActivityIndicator style={{ marginVertical: 16 }} color="#FF4D67" /> : null}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name={isError ? 'cloud-offline-outline' : 'person-add'} size={30} color={sub} />
              <Text style={[styles.emptyTitle, { color: textColor }]}>
                {isError ? 'Could not load requests' : 'No follow requests'}
              </Text>
              <Text style={[styles.emptyBody, { color: sub }]}>
                {isError
                  ? 'Pull down to try again.'
                  : 'When your account is private, people who want to follow you show up here.'}
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
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, gap: 4 },
  title: { fontSize: 20, fontFamily: 'Urbanist-Bold' },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10 },
  who: { flex: 1, flexDirection: 'row', alignItems: 'center', marginRight: 8 },
  names: { marginLeft: 12, flex: 1 },
  nameRow: { flexDirection: 'row', alignItems: 'center' },
  username: { fontFamily: 'Urbanist-Bold', fontSize: 15, flexShrink: 1 },
  fullName: { fontFamily: 'Urbanist-Regular', fontSize: 13, marginTop: 2 },
  actions: { flexDirection: 'row', gap: 8 },
  btn: { minHeight: 34, paddingHorizontal: 14, borderRadius: 10, justifyContent: 'center' },
  confirm: { backgroundColor: '#FF4D67' },
  confirmText: { color: '#FFF', fontFamily: 'Urbanist-Bold', fontSize: 13 },
  deleteText: { fontFamily: 'Urbanist-Bold', fontSize: 13 },
  done: { fontFamily: 'Urbanist-SemiBold', fontSize: 13 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, paddingTop: 80 },
  emptyTitle: { fontFamily: 'Urbanist-Bold', fontSize: 17, marginTop: 12 },
  emptyBody: { fontFamily: 'Urbanist-Regular', fontSize: 14, marginTop: 6, textAlign: 'center', lineHeight: 20 },
});
