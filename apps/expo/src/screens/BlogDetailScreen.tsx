import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  useColorScheme,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Share,
  Platform,
  useWindowDimensions,
} from 'react-native';
import { Image } from 'expo-image';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { blogService, BlogPost } from '@/src/services/blog/blogService';
import RenderHtml from '@/src/components/blog/RenderHtml';
import { Header } from '@/src/components/home/Header';

const FONT_SANS = Platform.select({
  web: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  default: undefined,
}) as any;
const ACCENT = '#FF3B30';

/**
 * Shared blog post screen, rendered by BOTH /blog/[slug] and the root-level
 * permalink /[slug] (original tophunt.in URLs). The post is resolved from the
 * `slug` route param. Designed as a clean, editorial reading experience.
 */
export default function BlogDetailScreen() {
  const router = useRouter();
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const isDark = useColorScheme() === 'dark';
  const { width } = useWindowDimensions();
  // Article lives in a centered, capped column so it reads well on tablets/desktop.
  const colW = Math.min(width, 800);
  const heroH = Math.min(Math.round(colW * 0.56), 360);

  const bg = isDark ? '#0D0D0F' : '#FFFFFF';
  const textColor = isDark ? '#FFFFFF' : '#111114';
  const subTextColor = isDark ? '#9B9BA3' : '#6A6A73';
  const cardBg = isDark ? '#0D0D0F' : '#FFFFFF';


  const [post, setPost] = useState<BlogPost | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!slug) return;
    (async () => {
      setLoading(true);
      setNotFound(false);
      const data = await blogService.getPost(String(slug));
      if (data) setPost(data);
      else setNotFound(true);
      setLoading(false);
    })();
  }, [slug]);

  const readMins = useMemo(() => {
    const words = (post?.content || '').replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
    return Math.max(1, Math.round(words / 200));
  }, [post]);

  const goToBlog = () => {
    try {
      router.replace('/blog');
    } catch {
      router.replace('/');
    }
  };

  const onShare = async () => {
    if (!post) return;
    try {
      await Share.share({ message: `${post.title}\n\nhttps://tophunt.in/${post.slug}` });
    } catch {
      /* cancelled */
    }
  };

  const formatDate = (ts?: number) => {
    if (!ts) return '';
    return new Date(ts).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  };

  return (
    <View style={[styles.container, { backgroundColor: bg }]}>
      {/* App global header (logo + notifications + chat) */}
      <Header />

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={ACCENT} />
        </View>
      ) : notFound || !post ? (
        <View style={styles.center}>
          <Text style={{ fontSize: 44 }}>{'\uD83D\uDCC4'}</Text>
          <Text style={{ color: textColor, marginTop: 14, fontSize: 20, fontWeight: '800', fontFamily: FONT_SANS }}>
            Post not found
          </Text>
          <Text style={{ color: subTextColor, marginTop: 6, fontFamily: FONT_SANS }}>
            This page isn’t available.
          </Text>
          <TouchableOpacity onPress={goToBlog} style={[styles.cta, { marginTop: 22 }]}>
            <Text style={styles.ctaText}>Browse the blog</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
          <View style={styles.columnWrap}>
            {/* Hero cover with floating back/share pills */}
            {post.coverImageUrl ? (
              <View style={styles.heroWrap}>
                <Image source={{ uri: post.coverImageUrl }} style={[styles.cover, { height: heroH }]} contentFit="cover" transition={220} />
                <View style={styles.heroOverlay} pointerEvents="box-none">
                  <TouchableOpacity onPress={goToBlog} style={styles.pill} hitSlop={6}>
                    <Text style={styles.pillText}>{'\u2190'}  All posts</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={onShare} style={styles.pill} hitSlop={6}>
                    <Text style={styles.pillText}>Share</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : null}

            {/* Content sheet (overlaps the hero) */}
            <View
              style={[
                styles.sheet,
                { backgroundColor: cardBg, marginTop: post.coverImageUrl ? -28 : 0 },
              ]}
            >
              {!post.coverImageUrl && (
                <TouchableOpacity onPress={goToBlog} style={styles.backInline} hitSlop={8}>
                  <Text style={[styles.backText, { color: subTextColor, fontFamily: FONT_SANS }]}>{'\u2190'}  All posts</Text>
                </TouchableOpacity>
              )}
              {!!post.category && (
                <View style={styles.categoryPill}>
                  <Text style={styles.categoryText}>{post.category.toUpperCase()}</Text>
                </View>
              )}

              <Text style={[styles.title, { color: textColor, fontFamily: FONT_SANS }]}>{post.title}</Text>

              <View style={styles.metaRow}>
                <View style={styles.avatar}>
                  <Text style={styles.avatarText}>{(post.author || 'T')[0].toUpperCase()}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.metaAuthor, { color: textColor, fontFamily: FONT_SANS }]}>
                    {post.author || 'TopHunt'}
                  </Text>
                  <Text style={[styles.metaSub, { color: subTextColor, fontFamily: FONT_SANS }]}>
                    {formatDate(post.publishedAt || post.createdAt)}
                    {'  ·  '}
                    {readMins} min read
                  </Text>
                </View>
              </View>

              <View style={[styles.divider, { backgroundColor: isDark ? '#232327' : '#EEEEF2' }]} />

              <RenderHtml html={post.content || ''} isDark={isDark} />

              {Array.isArray(post.tags) && post.tags.length > 0 && (
                <View style={styles.tags}>
                  {post.tags.map((t) => (
                    <View key={t} style={[styles.tag, { backgroundColor: isDark ? '#151517' : '#F4F4F7' }]}>
                      <Text style={[styles.tagText, { color: subTextColor, fontFamily: FONT_SANS }]}>#{t}</Text>
                    </View>
                  ))}
                </View>
              )}

              {/* Footer CTA */}
              <View style={[styles.footer, { borderTopColor: isDark ? '#232327' : '#EEEEF2' }]}>
                <TouchableOpacity onPress={goToBlog} style={styles.cta}>
                  <Text style={styles.ctaText}>Explore more posts  {'\u2192'}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  backInline: { alignSelf: 'flex-start', marginBottom: 14 },
  backText: { fontSize: 14.5, fontWeight: '600' },
  heroWrap: { width: '100%', position: 'relative' },
  heroOverlay: {
    position: 'absolute',
    top: 12,
    left: 12,
    right: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  pill: {
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingHorizontal: 13,
    paddingVertical: 7,
    borderRadius: 999,
    ...(Platform.OS === 'web' ? ({ backdropFilter: 'blur(6px)' } as any) : {}),
  },
  pillText: { color: '#fff', fontSize: 13, fontWeight: '700', fontFamily: FONT_SANS },
  scrollContent: { paddingBottom: 72, alignItems: 'center' },
  cover: { width: '100%' },
  columnWrap: { width: '100%', maxWidth: 800, alignSelf: 'center' },
  sheet: {
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: 20,
    paddingTop: 26,
  },
  categoryPill: {
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(255,59,48,0.12)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    marginBottom: 14,
  },
  categoryText: { color: ACCENT, fontSize: 11.5, fontWeight: '800', letterSpacing: 1, fontFamily: FONT_SANS },
  title: { fontSize: 30, fontWeight: '800', lineHeight: 39, letterSpacing: -0.6, marginBottom: 18 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  avatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: ACCENT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: '#fff', fontWeight: '800', fontSize: 17, fontFamily: FONT_SANS },
  metaAuthor: { fontSize: 15, fontWeight: '700' },
  metaSub: { fontSize: 13, marginTop: 2 },
  divider: { height: 1, marginVertical: 22 },
  tags: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 30, gap: 8 },
  tag: { paddingHorizontal: 13, paddingVertical: 7, borderRadius: 999 },
  tagText: { fontSize: 13, fontWeight: '600' },
  footer: { marginTop: 34, paddingTop: 22, borderTopWidth: 1, alignItems: 'flex-start' },
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: ACCENT,
    paddingHorizontal: 20,
    paddingVertical: 13,
    borderRadius: 999,
  },
  ctaText: { color: '#fff', fontWeight: '700', fontSize: 15, fontFamily: FONT_SANS },
});
