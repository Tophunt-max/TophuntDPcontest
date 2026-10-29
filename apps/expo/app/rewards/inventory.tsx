import React, { useMemo } from 'react';
import { View, Text, StyleSheet, SectionList, TouchableOpacity, RefreshControl, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { BackButton } from '@/src/components/ui/BackButton';
import { Ionicons } from '@/src/lib/icons';
import { emitToast } from '@/src/lib/toastBridge';
import { useAuth } from '@/src/hooks/useAuth';
import { BRAND, PAD, useExplorePalette, type ExplorePalette } from '@/src/components/explore/theme';
import { SectionError } from '@/src/components/explore/ExploreBits';
import { RarityPill } from '@/src/components/gamification/RarityPill';
import { assetColors } from '@/src/lib/progression';
import { useEquipCosmetic, useInventory, type InventoryItemView } from '@/src/services/gamification';

const SECTIONS: { type: string; title: string; equippable: boolean }[] = [
  { type: 'frame', title: 'Profile frames', equippable: true },
  { type: 'title', title: 'Titles', equippable: true },
  { type: 'theme', title: 'Themes', equippable: true },
  { type: 'badge', title: 'Badges', equippable: true },
  { type: 'effect', title: 'Celebration effects', equippable: true },
  { type: 'accessory', title: 'Avatar accessories', equippable: true },
  { type: 'sticker', title: 'Stickers', equippable: false },
  { type: 'collectible', title: 'Collectibles', equippable: false },
];

/**
 * Owned, locked and equipped cosmetics. Only owned items can be equipped, and
 * the server checks that again on every equip. Cosmetics are visual only.
 */
export default function InventoryScreen() {
  const p = useExplorePalette();
  const { user } = useAuth();
  const q = useInventory(!!user);
  const equip = useEquipCosmetic();

  const sections = useMemo(() => {
    const items = q.data?.items ?? [];
    return SECTIONS.map((s) => ({ ...s, data: items.filter((i) => i.type === s.type) })).filter((s) => s.data.length);
  }, [q.data]);

  const onEquip = (item: InventoryItemView, equippable: boolean) => {
    if (!equippable || !item.owned) return;
    equip.mutate(
      { slot: item.type, itemId: item.equipped ? null : item.id },
      {
        onSuccess: () => emitToast(item.equipped ? `${item.name} removed` : `${item.name} equipped`, 'success'),
        onError: (e: any) => emitToast(e?.message || 'Could not equip', 'error'),
      },
    );
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: p.bg }]} edges={['top']}>
      <View style={styles.header}>
        <BackButton size={24} color={p.text} style={{ marginRight: 12 }} />
        <Text style={[styles.headerTitle, { color: p.text }]} accessibilityRole="header">Inventory</Text>
      </View>
      {q.isLoading ? (
        <View style={styles.center}><ActivityIndicator color={BRAND} /></View>
      ) : q.isError ? (
        <View style={{ marginTop: 30 }}><SectionError palette={p} onRetry={() => q.refetch()} label="Inventory load nahi ho payi." /></View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(i) => i.id}
          stickySectionHeadersEnabled={false}
          contentContainerStyle={{ paddingBottom: 40 }}
          refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => q.refetch()} tintColor={BRAND} />}
          renderSectionHeader={({ section }) => <Text style={[styles.section, { color: p.text }]}>{section.title}</Text>}
          renderItem={({ item, section }) => (
            <ItemRow item={item} p={p} equippable={section.equippable} busy={equip.isPending} onPress={() => onEquip(item, section.equippable)} />
          )}
        />
      )}
    </SafeAreaView>
  );
}

const ItemRow = React.memo(function ItemRow({
  item, p, equippable, busy, onPress,
}: { item: InventoryItemView; p: ExplorePalette; equippable: boolean; busy: boolean; onPress: () => void }) {
  const colors = assetColors(item.asset);
  const state = item.owned ? (item.equipped ? 'Equipped' : equippable ? 'Owned' : 'In your collection') : item.unlocksAtLevel ? `Unlocks at level ${item.unlocksAtLevel}` : 'Locked';
  return (
    <View style={[styles.row, { backgroundColor: p.card, borderColor: item.equipped ? BRAND : p.border, opacity: item.owned ? 1 : 0.7 }]}>
      <LinearGradient colors={colors} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.swatch}>
        {!item.owned ? <Ionicons name="lock-closed" size={16} color="#FFF" /> : item.asset?.icon ? <Ionicons name={String(item.asset.icon)} size={18} color="#FFF" /> : null}
      </LinearGradient>
      <View style={{ flex: 1 }}>
        <View style={styles.titleRow}>
          <Text style={[styles.name, { color: p.text }]} numberOfLines={1}>{item.name}</Text>
          <RarityPill rarity={item.rarity} />
        </View>
        <Text style={[styles.desc, { color: p.sub }]} numberOfLines={2}>{item.description}</Text>
        <Text style={[styles.state, { color: item.equipped ? BRAND : p.sub }]}>{state}</Text>
      </View>
      {equippable && item.owned ? (
        <TouchableOpacity
          style={[styles.btn, item.equipped ? { backgroundColor: p.chip } : { backgroundColor: BRAND }]}
          onPress={onPress}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={item.equipped ? `Remove ${item.name}` : `Equip ${item.name}`}
        >
          <Text style={[styles.btnText, { color: item.equipped ? p.text : '#FFF' }]}>{item.equipped ? 'Remove' : 'Equip'}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', height: 56, paddingHorizontal: 16 },
  headerTitle: { fontSize: 22, fontFamily: 'Urbanist-Bold' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  section: { fontSize: 16, fontFamily: 'Urbanist-Bold', paddingHorizontal: PAD, marginTop: 16, marginBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: PAD, marginBottom: 10, padding: 12, borderRadius: 16, borderWidth: 1 },
  swatch: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { fontSize: 15, fontFamily: 'Urbanist-Bold', flexShrink: 1 },
  desc: { fontSize: 12, fontFamily: 'Urbanist-Medium', marginTop: 2 },
  state: { fontSize: 11, fontFamily: 'Urbanist-SemiBold', marginTop: 4 },
  btn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 14 },
  btnText: { fontSize: 12, fontFamily: 'Urbanist-Bold' },
});
