/**
 * "My Prizes" — every physical prize this user has won, and what is happening to it.
 *
 * Coin winnings need no screen: they are in the wallet the moment a battle settles.
 * A product cannot be sent anywhere until the winner tells us where, so this is the
 * one place in the app where a user has to act to receive something already won.
 * That makes the `unclaimed` card the most important thing here, and it is why it
 * gets a real button rather than a status line.
 */
import React, { useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  FlatList,
  ActivityIndicator,
  TouchableOpacity,
  RefreshControl,
} from 'react-native';
import { router } from 'expo-router';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { Ionicons } from '@/src/lib/icons';
import { AppImage as Image } from '@/src/components/ui/AppImage';
import { BackButton } from '@/src/components/ui/BackButton';
import { ArrowIcon } from '@/src/components/ui/ArrowIcon';
import { EmptyState, ErrorState } from '@/src/components/ui/StateViews';
import { PrizeStatusPill, prizeStatusMeta } from '@/src/components/prizes/prizeStatus';
import { useMyPrizes } from '@/src/hooks/usePrizes';
import type { PrizeClaim } from '@/src/services/prizes/prizeService';
import { Colors } from '@/constants/theme';

export default function PrizesScreen() {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const backgroundColor = isDark ? Colors.dark.background : '#F8F9FA';
  const cardBg = isDark ? '#1F222A' : '#FFFFFF';
  const textColor = isDark ? Colors.dark.text : '#121212';
  const subTextColor = isDark ? '#A0A0A0' : '#757575';
  const borderColor = isDark ? '#23262D' : '#EEF0F4';

  const { data: prizes = [], isLoading, isError, refetch, isRefetching } = useMyPrizes();

  // Anything the winner must act on floats to the top. The server orders by "won
  // most recently", which is the right default but buries a month-old unclaimed
  // phone under three delivered ones.
  const ordered = useMemo(() => {
    const rank = (claim: PrizeClaim) => (prizeStatusMeta(claim.status).actionable ? 0 : 1);
    return [...prizes].sort((a, b) => rank(a) - rank(b) || b.createdAt - a.createdAt);
  }, [prizes]);

  const open = useCallback((claim: PrizeClaim) => {
    router.push(`/prizes/${claim.matchId}` as any);
  }, []);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]}>
      <View style={[styles.header, { borderBottomColor: borderColor }]}>
        <BackButton size={24} color={textColor} style={styles.backBtn} />
        <View style={styles.titleWrap}>
          <Ionicons name="cube" size={16} color="#A78BFA" />
          <Text style={[styles.title, { color: textColor }]}>My Prizes</Text>
        </View>
        <View style={styles.backBtn} />
      </View>

      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#FF4D67" />
        </View>
      ) : isError ? (
        <ErrorState
          title="Could not load your prizes"
          subtitle="Check your connection and try again — nothing you have won is lost."
          onAction={refetch}
        />
      ) : (
        <FlatList
          data={ordered}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <PrizeCard
              claim={item}
              cardBg={cardBg}
              textColor={textColor}
              subTextColor={subTextColor}
              borderColor={borderColor}
              onPress={() => open(item)}
            />
          )}
          refreshControl={
            <RefreshControl
              refreshing={isRefetching}
              onRefresh={refetch}
              tintColor="#FF4D67"
              colors={['#FF4D67']}
            />
          }
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          removeClippedSubviews
          initialNumToRender={8}
          maxToRenderPerBatch={8}
          windowSize={9}
          updateCellsBatchingPeriod={50}
          ListEmptyComponent={
            <EmptyState
              icon="cube-outline"
              title="No prizes yet"
              subtitle="Win a battle in a contest that awards a product and it will show up here, ready to claim."
            />
          }
        />
      )}
    </SafeAreaView>
  );
}

function PrizeCard({
  claim,
  cardBg,
  textColor,
  subTextColor,
  borderColor,
  onPress,
}: {
  claim: PrizeClaim;
  cardBg: string;
  textColor: string;
  subTextColor: string;
  borderColor: string;
  onPress: () => void;
}) {
  const meta = prizeStatusMeta(claim.status);

  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={onPress}
      style={[styles.card, { backgroundColor: cardBg, borderColor }]}
      accessibilityRole="button"
      accessibilityLabel={`${claim.productTitle}. ${meta.detail}`}
    >
      <View style={styles.cardTop}>
        <View style={[styles.thumb, { backgroundColor: borderColor }]}>
          {claim.productImageUrl ? (
            <Image source={{ uri: claim.productImageUrl }} style={styles.thumbImg} contentFit="cover" />
          ) : (
            <Ionicons name="cube" size={22} color={subTextColor} />
          )}
        </View>
        <View style={styles.cardBody}>
          <Text style={[styles.productTitle, { color: textColor }]} numberOfLines={2}>
            {claim.productTitle}
          </Text>
          {claim.productValue > 0 && (
            <Text style={[styles.productValue, { color: subTextColor }]}>Worth ₹{claim.productValue}</Text>
          )}
          <View style={styles.pillRow}>
            <PrizeStatusPill status={claim.status} />
          </View>
        </View>
      </View>

      <Text style={[styles.detail, { color: subTextColor }]}>
        {claim.status === 'cancelled' && claim.adminNote ? claim.adminNote : meta.detail}
      </Text>

      {/* Follows the data, not one status — a delivered parcel still has a number. */}
      {claim.trackingNumber && (
        <View style={[styles.trackingBox, { borderColor }]}>
          <Ionicons name="car" size={13} color={subTextColor} />
          <Text style={[styles.trackingText, { color: textColor }]} numberOfLines={1}>
            {claim.courier} · {claim.trackingNumber}
          </Text>
        </View>
      )}

      {/* The one status that is a task rather than news gets a real button. */}
      {meta.actionable ? (
        <View style={styles.claimBtn}>
          <Text style={styles.claimBtnText}>Add delivery address</Text>
          <ArrowIcon size={15} color="#FFF" variant="arrow" />
        </View>
      ) : (
        <View style={styles.viewRow}>
          <Text style={[styles.viewText, { color: subTextColor }]}>
            {claim.canEditAddress ? 'View or edit address' : 'View details'}
          </Text>
          <ArrowIcon size={14} color={subTextColor} variant="arrow" />
        </View>
      )}
    </TouchableOpacity>
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
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  listContent: { padding: 16, paddingBottom: 40, gap: 12 },

  card: { borderRadius: 18, borderWidth: 1, padding: 14, gap: 10 },
  cardTop: { flexDirection: 'row', gap: 12 },
  thumb: {
    width: 64,
    height: 64,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  thumbImg: { width: '100%', height: '100%' },
  cardBody: { flex: 1, gap: 3 },
  productTitle: { fontFamily: 'Urbanist-Bold', fontSize: 16, lineHeight: 20 },
  productValue: { fontFamily: 'Urbanist-SemiBold', fontSize: 12 },
  pillRow: { flexDirection: 'row', marginTop: 3 },
  detail: { fontFamily: 'Urbanist-Medium', fontSize: 13, lineHeight: 18 },

  trackingBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  trackingText: { fontFamily: 'Urbanist-SemiBold', fontSize: 12, flexShrink: 1 },

  claimBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#FF4D67',
    borderRadius: 14,
    paddingVertical: 13,
  },
  claimBtnText: { color: '#FFF', fontFamily: 'Urbanist-Bold', fontSize: 14 },
  viewRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  viewText: { fontFamily: 'Urbanist-SemiBold', fontSize: 13 },
});
