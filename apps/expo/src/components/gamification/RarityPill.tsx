import React from 'react';
import { Text, StyleSheet, View } from 'react-native';
import { rarityColor, rarityLabel } from '@/src/lib/progression';

/** Rarity is visual only: it never means voting power or a paid tier. */
export function RarityPill({ rarity }: { rarity?: string | null }) {
  const color = rarityColor(rarity);
  return (
    <View style={[styles.pill, { backgroundColor: `${color}22` }]}>
      <Text style={[styles.text, { color }]}>{rarityLabel(rarity)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8, alignSelf: 'flex-start' },
  text: { fontSize: 10, fontFamily: 'Urbanist-Bold', letterSpacing: 0.3 },
});
