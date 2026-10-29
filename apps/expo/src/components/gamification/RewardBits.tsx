/**
 * Reusable reward UI: XP gain pill, achievement icon, cosmetic preview, reward
 * card, reward bottom sheet, and the loading / empty / error states.
 *
 * None of these decide anything. Ownership, unlock and claim state come from
 * the server and are passed in; the only action a card can take is calling the
 * handler it was given (which calls the Worker).
 */
import React from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Avatar } from '@/src/components/ui/Avatar';
import { Ionicons } from '@/src/lib/icons';
import {
  achievementAsset,
  cosmeticAsset,
  frameTier,
  resolveAsset,
  type AssetKey,
  type MilestoneState,
} from '@/src/lib/gamificationAssets';
import { assetColors, rarityColor } from '@/src/lib/progression';
import type { ExplorePalette } from '@/src/components/explore/theme';
import { GamificationIcon } from './GamificationIcon';
import { RarityPill } from './RarityPill';
import { EmptyInventory, FrameRing } from './vectors';

const BRAND = '#FF4D67';

/** "+25 XP" chip with the XP spark. */
export function XpGainPill({ amount, compact = false }: { amount: number; compact?: boolean }) {
  if (!Number.isFinite(amount) || amount === 0) return null;
  const pos = amount > 0;
  return (
    <View
      style={[styles.pill, { backgroundColor: pos ? '#FFF4D6' : '#FDECEC', paddingVertical: compact ? 1 : 3 }]}
      accessible
      accessibilityLabel={`${pos ? 'Gained' : 'Lost'} ${Math.abs(amount)} XP`}
    >
      <GamificationIcon assetKey={pos ? 'xp.star' : 'xp.history'} size={compact ? 11 : 13} color={pos ? '#E08E00' : '#C62828'} />
      <Text style={[styles.pillText, { color: pos ? '#8A5700' : '#C62828', fontSize: compact ? 11 : 12 }]}>
        {pos ? '+' : '−'}{Math.abs(amount)} XP
      </Text>
    </View>
  );
}

/** Achievement disc: artwork when unlocked, the lock placeholder when not. */
export function AchievementIcon({
  a,
  size = 44,
  dark = false,
}: {
  a: { id: string; icon?: string | null; unlocked?: boolean; rarity?: string | null };
  size?: number;
  dark?: boolean;
}) {
  const def = achievementAsset(a);
  const ring = a.unlocked === false ? '#9AA3AD' : rarityColor(a.rarity);
  return (
    <View style={[styles.disc, { width: size, height: size, borderRadius: size / 2, backgroundColor: `${ring}22`, borderColor: `${ring}66` }]}>
      {def.kind === 'vector' && def.vector === 'lockBadge' ? (
        <GamificationIcon def={def} size={size * 0.86} color={dark ? '#6B7280' : '#9AA3AD'} />
      ) : (
        <GamificationIcon def={def} size={size * 0.52} />
      )}
    </View>
  );
}

/**
 * Preview of a cosmetic. Frames are shown on the viewer's own avatar (so they
 * can judge the fit); everything else shows its artwork. Unowned items get a
 * lock overlay and are dimmed — and the label says "Locked", not only the look.
 */
export function CosmeticPreview({
  item,
  size = 52,
  avatarUri,
  name,
}: {
  item: { id: string; type: string; name: string; rarity?: string | null; asset: Record<string, any>; owned?: boolean };
  size?: number;
  avatarUri?: string | null;
  name?: string | null;
}) {
  const locked = item.owned === false;
  const tier = item.type === 'frame' ? frameTier(item) : null;
  return (
    <View style={{ width: size, height: size, opacity: locked ? 0.55 : 1 }} accessible accessibilityLabel={`${item.name}${locked ? ', locked' : ''}`}>
      {tier ? (
        <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
          <FrameRing tier={tier.id} size={size * 0.82} thickness={size * 0.09} />
          <View style={{ position: 'absolute', top: size * 0.09, left: size * 0.09 }}>
            <Avatar uri={avatarUri ?? undefined} name={name || 'You'} size={size * 0.82} />
          </View>
        </View>
      ) : item.type === 'title' ? (
        <View style={[styles.titleChip, { height: size * 0.6, borderColor: rarityColor(item.rarity) }]}>
          <GamificationIcon assetKey="cosmetic.title" size={size * 0.24} />
          <Text style={[styles.titleChipText, { color: rarityColor(item.rarity) }]} numberOfLines={1}>{String(item.asset?.text ?? item.name)}</Text>
        </View>
      ) : (
        <View style={[styles.disc, { width: size, height: size, borderRadius: size / 2, backgroundColor: `${assetColors(item.asset)[0]}33`, borderColor: `${assetColors(item.asset)[1]}88` }]}>
          {item.asset?.icon ? (
            <Ionicons name={String(item.asset.icon)} size={size * 0.46} color={assetColors(item.asset)[1]} />
          ) : (
            <GamificationIcon def={cosmeticAsset({ ...item, owned: true })} size={size * 0.46} />
          )}
        </View>
      )}
      {locked ? (
        <View style={[styles.lockOverlay, { width: size * 0.42, height: size * 0.42, borderRadius: size * 0.21 }]}>
          <Ionicons name="lock-closed" size={size * 0.22} color="#FFFFFF" />
        </View>
      ) : null}
    </View>
  );
}

export type RewardCardState = MilestoneState | 'unavailable';

const STATE_COPY: Record<RewardCardState, { label: string; key: AssetKey; color: string }> = {
  locked: { label: 'Locked', key: 'reward.locked', color: '#9AA3AD' },
  available: { label: 'Ready to claim', key: 'reward.claimable', color: BRAND },
  unlocked: { label: 'Unlocked', key: 'reward.unlocked', color: '#22C55E' },
  claimed: { label: 'Claimed', key: 'reward.claimed', color: '#22C55E' },
  unavailable: { label: 'Not available right now', key: 'reward.locked', color: '#9AA3AD' },
};

/** A reward row/card with an explicit state, icon and optional action. */
export function RewardCard({
  p,
  title,
  subtitle,
  assetKey,
  state,
  rarity,
  actionLabel,
  onAction,
  busy,
  onPress,
}: {
  p: ExplorePalette;
  title: string;
  subtitle?: string | null;
  assetKey?: AssetKey | string;
  state: RewardCardState;
  rarity?: string | null;
  actionLabel?: string;
  onAction?: () => void;
  busy?: boolean;
  onPress?: () => void;
}) {
  const s = STATE_COPY[state];
  const muted = state === 'locked' || state === 'unavailable';
  const body = (
    <View style={[styles.card, { backgroundColor: p.card, borderColor: state === 'available' ? BRAND : p.border }]}>
      <View style={[styles.cardIcon, { backgroundColor: p.chip }]}>
        <GamificationIcon assetKey={muted ? s.key : assetKey ?? s.key} size={26} muted={muted} />
      </View>
      <View style={{ flex: 1 }}>
        <View style={styles.titleRow}>
          <Text style={[styles.cardTitle, { color: muted ? p.sub : p.text }]} numberOfLines={2}>{title}</Text>
          {rarity ? <RarityPill rarity={rarity} /> : null}
        </View>
        {subtitle ? <Text style={[styles.cardSub, { color: p.sub }]} numberOfLines={2}>{subtitle}</Text> : null}
        <View style={styles.stateRow}>
          <GamificationIcon assetKey={s.key} size={12} color={s.color} />
          <Text style={[styles.stateText, { color: s.color }]}>{s.label}</Text>
        </View>
      </View>
      {actionLabel && onAction ? (
        <TouchableOpacity
          style={[styles.btn, (busy || state !== 'available') && { opacity: 0.45 }]}
          disabled={busy || state !== 'available'}
          onPress={onAction}
          accessibilityRole="button"
          accessibilityLabel={`${actionLabel}: ${title}`}
          accessibilityState={{ disabled: busy || state !== 'available', busy: !!busy }}
        >
          {busy ? <ActivityIndicator color="#FFF" size="small" /> : <Text style={styles.btnText}>{actionLabel}</Text>}
        </TouchableOpacity>
      ) : null}
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${title}, ${s.label}`}>
      {body}
    </Pressable>
  );
}

/** A bottom sheet for reward / milestone details. Dismiss by tapping outside or Close. */
export function RewardSheet({
  visible,
  onClose,
  p,
  title,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  p: ExplorePalette;
  title: string;
  children: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" accessibilityRole="button" />
      <View style={[styles.sheet, { backgroundColor: p.card, paddingBottom: insets.bottom + 20 }]} accessibilityViewIsModal>
        <View style={[styles.grabber, { backgroundColor: p.border }]} />
        <Text style={[styles.sheetTitle, { color: p.text }]} accessibilityRole="header">{title}</Text>
        {children}
        <TouchableOpacity style={[styles.sheetClose, { backgroundColor: p.chip }]} onPress={onClose} accessibilityRole="button">
          <Text style={[styles.btnText, { color: p.text }]}>Close</Text>
        </TouchableOpacity>
      </View>
    </Modal>
  );
}

/** Loading placeholder with a fixed height, so content does not jump in. */
export function GamificationLoading({ height = 120, p }: { height?: number; p: ExplorePalette }) {
  return (
    <View style={[styles.state, { height, backgroundColor: p.card, borderColor: p.border }]} accessibilityLabel="Loading">
      <ActivityIndicator color={BRAND} />
    </View>
  );
}

export function GamificationEmpty({ p, text, actionText, onAction }: { p: ExplorePalette; text: string; actionText?: string; onAction?: () => void }) {
  return (
    <View style={[styles.state, { backgroundColor: p.card, borderColor: p.border, paddingVertical: 24 }]}>
      <EmptyInventory size={84} color={p.sub} />
      <Text style={[styles.stateBody, { color: p.sub }]}>{text}</Text>
      {actionText && onAction ? (
        <TouchableOpacity style={styles.btn} onPress={onAction} accessibilityRole="button">
          <Text style={styles.btnText}>{actionText}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

export function GamificationError({ p, text, onRetry }: { p: ExplorePalette; text: string; onRetry: () => void }) {
  return (
    <View style={[styles.state, { backgroundColor: p.card, borderColor: p.border, paddingVertical: 24 }]}>
      <Ionicons name="cloud-offline-outline" size={26} color={p.sub} />
      <Text style={[styles.stateBody, { color: p.sub }]}>{text}</Text>
      <TouchableOpacity style={styles.btn} onPress={onRetry} accessibilityRole="button">
        <Text style={styles.btnText}>Retry</Text>
      </TouchableOpacity>
    </View>
  );
}

/** Resolve a key's label for screen readers next to an icon. */
export const assetLabel = (key: string) => resolveAsset(key).label;

const styles = StyleSheet.create({
  pill: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 7, borderRadius: 10, alignSelf: 'flex-start' },
  pillText: { fontFamily: 'Urbanist-Bold' },
  disc: { alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  titleChip: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 6, borderRadius: 8, borderWidth: 1.5, alignSelf: 'center', marginTop: '20%', maxWidth: '100%' },
  titleChipText: { fontSize: 10, fontFamily: 'Urbanist-Bold', flexShrink: 1 },
  lockOverlay: { position: 'absolute', right: -2, bottom: -2, backgroundColor: 'rgba(31,41,51,0.85)', alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: '#FFFFFF' },
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 16, borderWidth: 1 },
  cardIcon: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center' },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cardTitle: { fontSize: 14, fontFamily: 'Urbanist-Bold', flexShrink: 1 },
  cardSub: { fontSize: 12, fontFamily: 'Urbanist-Medium', marginTop: 2 },
  stateRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
  stateText: { fontSize: 11, fontFamily: 'Urbanist-Bold' },
  btn: { backgroundColor: BRAND, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 14, minWidth: 64, alignItems: 'center' },
  btnText: { color: '#FFF', fontFamily: 'Urbanist-Bold', fontSize: 12 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: { borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, gap: 12, maxWidth: 640, width: '100%', alignSelf: 'center' },
  grabber: { width: 40, height: 4, borderRadius: 2, alignSelf: 'center' },
  sheetTitle: { fontSize: 18, fontFamily: 'Urbanist-Bold' },
  sheetClose: { alignItems: 'center', paddingVertical: 12, borderRadius: 14, marginTop: 4 },
  state: { borderRadius: 18, borderWidth: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 20 },
  stateBody: { fontSize: 13, fontFamily: 'Urbanist-Medium', textAlign: 'center' },
});
