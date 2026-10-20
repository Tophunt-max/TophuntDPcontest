import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@/src/lib/icons';
import { ArrowIcon } from '@/src/components/ui/ArrowIcon';
import { Skeleton } from '@/src/components/ui/Skeleton';
import { BRAND, PAD, type ExplorePalette } from './theme';

/** Section title with an optional emoji/icon and "See all". */
export function SectionHeader({
  title,
  icon,
  iconColor = BRAND,
  palette,
  onSeeAll,
  right,
}: {
  title: string;
  icon?: string;
  iconColor?: string;
  palette: ExplorePalette;
  onSeeAll?: () => void;
  right?: React.ReactNode;
}) {
  return (
    <View style={styles.header}>
      {icon ? <Ionicons name={icon} size={18} color={iconColor} /> : null}
      <Text style={[styles.title, { color: palette.text }]} accessibilityRole="header" numberOfLines={1}>
        {title}
      </Text>
      <View style={{ flex: 1 }} />
      {right}
      {onSeeAll ? (
        <TouchableOpacity onPress={onSeeAll} style={styles.seeAll} accessibilityRole="link" accessibilityLabel={`See all ${title}`} hitSlop={8}>
          <Text style={styles.seeAllText}>See all</Text>
          <ArrowIcon size={12} color={BRAND} variant="arrow" />
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

/** A section that failed to load: says so, and offers a retry (never a fake "empty"). */
export function SectionError({ palette, onRetry, label = 'Ye section load nahi ho paya.' }: { palette: ExplorePalette; onRetry: () => void; label?: string }) {
  return (
    <View style={[styles.box, { borderColor: palette.border, backgroundColor: palette.card }]}>
      <Ionicons name="cloud-offline-outline" size={22} color={palette.sub} />
      <Text style={[styles.boxText, { color: palette.sub }]}>{label}</Text>
      <TouchableOpacity onPress={onRetry} style={styles.retry} accessibilityRole="button">
        <Ionicons name="refresh" size={14} color="#FFF" />
        <Text style={styles.retryText}>Retry</Text>
      </TouchableOpacity>
    </View>
  );
}

export function SectionEmpty({
  palette,
  text,
  icon = 'star-outline',
  actionText,
  onAction,
}: {
  palette: ExplorePalette;
  text: string;
  icon?: string;
  actionText?: string;
  onAction?: () => void;
}) {
  return (
    <View style={[styles.box, styles.dashed, { borderColor: palette.border }]}>
      <Ionicons name={icon} size={24} color={palette.sub} />
      <Text style={[styles.boxText, { color: palette.sub }]}>{text}</Text>
      {actionText && onAction ? (
        <TouchableOpacity onPress={onAction} accessibilityRole="button">
          <Text style={styles.action}>{actionText}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

/** Horizontal rail placeholder that matches the real card size (no layout jump). */
export function RailSkeleton({ width, height, count = 3, radius = 20 }: { width: number; height: number; count?: number; radius?: number }) {
  return (
    <View style={styles.rail}>
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} width={width} height={height} borderRadius={radius} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: PAD, marginTop: 26, marginBottom: 12 },
  title: { fontSize: 19, fontFamily: 'Urbanist-Bold', flexShrink: 1 },
  seeAll: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4, paddingLeft: 8 },
  seeAllText: { color: BRAND, fontSize: 13, fontFamily: 'Urbanist-Bold' },
  box: { marginHorizontal: PAD, borderRadius: 18, borderWidth: 1, paddingVertical: 20, paddingHorizontal: 16, alignItems: 'center', gap: 8 },
  dashed: { borderStyle: 'dashed', borderWidth: 1.5 },
  boxText: { fontSize: 13, fontFamily: 'Urbanist-Medium', textAlign: 'center' },
  retry: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: BRAND, paddingHorizontal: 16, paddingVertical: 8, borderRadius: 100, marginTop: 4 },
  retryText: { color: '#FFF', fontSize: 13, fontFamily: 'Urbanist-Bold' },
  action: { color: BRAND, fontSize: 13, fontFamily: 'Urbanist-Bold', marginTop: 2 },
  rail: { flexDirection: 'row', gap: 12, paddingHorizontal: PAD },
});
