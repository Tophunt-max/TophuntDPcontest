import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, FlatList, Linking, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { bannerTarget } from '@/src/lib/exploreMedia';
import { ScaleTouchable } from './ScaleTouchable';
import { BRAND, PAD } from './theme';

export interface ExploreBanner {
  id: string;
  imageUrl: string;
  title?: string;
  subtitle?: string;
  link?: string;
}

const AUTO_MS = 5000;

/**
 * Admin-managed promo carousel (appConfig.explore.banners, already filtered to
 * live ones by the server). Pages one banner at a time, auto-advances every 5s,
 * and pauses while the user is dragging.
 */
export function BannerCarousel({ banners, width }: { banners: ExploreBanner[]; width: number }) {
  const router = useRouter();
  const list = useRef<FlatList<ExploreBanner>>(null);
  const [index, setIndex] = useState(0);
  const dragging = useRef(false);
  const itemW = width - PAD * 2;
  const height = Math.round(itemW * 0.42);
  const step = itemW + 12;

  useEffect(() => {
    if (banners.length < 2) return;
    const t = setInterval(() => {
      if (dragging.current) return;
      setIndex((i) => {
        const next = (i + 1) % banners.length;
        list.current?.scrollToOffset({ offset: next * step, animated: true });
        return next;
      });
    }, AUTO_MS);
    return () => clearInterval(t);
  }, [banners.length, step]);

  const onScrollEnd = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      dragging.current = false;
      setIndex(Math.max(0, Math.min(banners.length - 1, Math.round(e.nativeEvent.contentOffset.x / step))));
    },
    [banners.length, step],
  );

  const open = (b: ExploreBanner) => {
    const t = bannerTarget(b.link);
    if (!t) return;
    if (t.kind === 'route') router.push(t.to as any);
    else Linking.openURL(t.to).catch(() => {});
  };

  if (!banners.length) return null;

  return (
    <View style={{ marginTop: 18 }}>
      <FlatList
        ref={list}
        data={banners}
        keyExtractor={(b) => b.id}
        horizontal
        showsHorizontalScrollIndicator={false}
        snapToInterval={step}
        decelerationRate="fast"
        contentContainerStyle={{ paddingHorizontal: PAD, gap: 12 }}
        onScrollBeginDrag={() => (dragging.current = true)}
        onMomentumScrollEnd={onScrollEnd}
        getItemLayout={(_, i) => ({ length: step, offset: step * i, index: i })}
        renderItem={({ item }) => (
          <ScaleTouchable
            style={[styles.card, { width: itemW, height }]}
            onPress={() => open(item)}
            disabled={!bannerTarget(item.link)}
            accessibilityRole={bannerTarget(item.link) ? 'link' : 'image'}
            accessibilityLabel={[item.title, item.subtitle].filter(Boolean).join('. ') || 'Promotion'}
          >
            <Image source={{ uri: item.imageUrl }} style={StyleSheet.absoluteFill} contentFit="cover" transition={200} cachePolicy="memory-disk" />
            {item.title || item.subtitle ? (
              <LinearGradient colors={['transparent', 'rgba(0,0,0,0.72)']} style={styles.scrim}>
                {item.title ? <Text style={styles.title} numberOfLines={1}>{item.title}</Text> : null}
                {item.subtitle ? <Text style={styles.subtitle} numberOfLines={1}>{item.subtitle}</Text> : null}
              </LinearGradient>
            ) : null}
          </ScaleTouchable>
        )}
      />
      {banners.length > 1 && (
        <View style={styles.dots} accessibilityElementsHidden>
          {banners.map((b, i) => (
            <View key={b.id} style={[styles.dot, i === index && styles.dotActive]} />
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 20, overflow: 'hidden', backgroundColor: '#222' },
  scrim: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 16, paddingTop: 28, paddingBottom: 12 },
  title: { color: '#FFF', fontSize: 17, fontFamily: 'Urbanist-Bold' },
  subtitle: { color: 'rgba(255,255,255,0.85)', fontSize: 12, fontFamily: 'Urbanist-Medium', marginTop: 2 },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 6, marginTop: 10 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: 'rgba(128,128,128,0.35)' },
  dotActive: { width: 18, backgroundColor: BRAND },
});
