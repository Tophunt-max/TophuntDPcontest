import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useResolvedColorScheme } from '@/src/lib/themePreference';
import { Skeleton } from '../ui/Skeleton';

/**
 * Blog post cards while the list loads. The screen renders its real header and
 * category chips above this, so only the cards are drawn. Mirrors card styles
 * in app/blog/index.tsx: marginH 16, marginB 16, radius 18, shadow; a 220
 * featured image then 170 images; body padding 14 with an 11pt category
 * (mb 6), an 18pt title on a 24 line (mb 6), a 14pt excerpt on a 20 line
 * (mb 10) and a 12pt meta row split left / right.
 */
export const BlogSkeleton = ({ featured = true }: { featured?: boolean }) => {
  const isDark = useResolvedColorScheme() === 'dark';
  const cardBg = isDark ? '#1C1C1E' : '#FFFFFF';

  const card = (big: boolean, key: number) => (
    <View key={key} style={[styles.card, { backgroundColor: cardBg }]}>
      <Skeleton width="100%" height={big ? 220 : 170} borderRadius={0} />
      <View style={styles.body}>
        <Skeleton width={64} height={10} borderRadius={5} style={{ marginBottom: 7 }} />
        <Skeleton width="92%" height={17} borderRadius={7} style={{ marginTop: 3 }} />
        <Skeleton width={big ? '70%' : '55%'} height={17} borderRadius={7} style={{ marginTop: 7, marginBottom: 9 }} />
        <Skeleton width="100%" height={13} borderRadius={6} style={{ marginTop: 3 }} />
        <Skeleton width="76%" height={13} borderRadius={6} style={{ marginTop: 7, marginBottom: 13 }} />
        <View style={styles.meta}>
          <Skeleton width={90} height={11} borderRadius={5} />
          <Skeleton width={56} height={11} borderRadius={5} />
        </View>
      </View>
    </View>
  );

  return <View>{[0, 1, 2].map((i) => card(featured && i === 0, i))}</View>;
};

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 16,
    marginBottom: 16,
    borderRadius: 18,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 10,
    elevation: 3,
  },
  body: { padding: 14 },
  meta: { flexDirection: 'row', justifyContent: 'space-between' },
});

export default BlogSkeleton;
