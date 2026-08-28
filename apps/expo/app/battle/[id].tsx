import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, StatusBar, Dimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { StoryVsFrame } from '@/src/components/stories/StoryVsFrame';

/**
 * Public landing for a shared battle: `https://tophunt.in/battle/<id>`.
 *
 * This is the target of every share link (see src/lib/share.ts). On a device
 * with the app installed the verified App Link (app.json intentFilters) opens
 * the app straight here; in a browser the web build serves the same page. Either
 * way the visitor sees the actual head-to-head — both entries with the VS badge,
 * or the composite card once one exists — instead of the old dead
 * `tophunt.app/battle/<id>` that went nowhere.
 *
 * It reuses StoryVsFrame, so there is one renderer for the battle everywhere it
 * appears.
 */
const { height } = Dimensions.get('window');

export default function BattleLanding() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();

  const goVote = () => {
    // Into the app to vote. `replace` so the shared entry point isn't left on
    // the back stack.
    router.replace('/');
  };

  if (!id) {
    return (
      <View style={styles.missing}>
        <Text style={styles.missingText}>This battle link is invalid.</Text>
        <TouchableOpacity style={styles.cta} onPress={goVote}>
          <Text style={styles.ctaText}>Open TopHunt</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" />
      <View style={styles.frameWrap}>
        <StoryVsFrame matchId={String(id)} />
      </View>

      {/* Bottom CTA over a scrim so it stays readable on any card. */}
      <LinearGradient pointerEvents="none" colors={['transparent', 'rgba(0,0,0,0.85)']} style={styles.scrim} />
      <SafeAreaView edges={['bottom']} style={styles.footer} pointerEvents="box-none">
        <Text style={styles.tagline}>Fans decide the winner.</Text>
        <TouchableOpacity style={styles.cta} onPress={goVote} accessibilityRole="button" accessibilityLabel="Vote on TopHunt">
          <Text style={styles.ctaText}>Vote on TopHunt</Text>
        </TouchableOpacity>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  frameWrap: { flex: 1 },
  scrim: { position: 'absolute', left: 0, right: 0, bottom: 0, height: height * 0.28 },
  footer: { position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'center', paddingHorizontal: 24, paddingBottom: 24 },
  tagline: { color: 'rgba(255,255,255,0.85)', fontFamily: 'Urbanist-Medium', fontSize: 14, marginBottom: 12 },
  cta: { backgroundColor: '#FF4D67', height: 54, borderRadius: 27, alignItems: 'center', justifyContent: 'center', alignSelf: 'stretch', maxWidth: 420 },
  ctaText: { color: '#fff', fontFamily: 'Urbanist-Bold', fontSize: 16 },
  missing: { flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center', padding: 24, gap: 16 },
  missingText: { color: '#fff', fontFamily: 'Urbanist-Medium', fontSize: 15, textAlign: 'center' },
});
