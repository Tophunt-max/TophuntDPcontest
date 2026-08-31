import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Share,
  Platform,
  useWindowDimensions,
} from 'react-native';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { AppImage as Image } from '@/src/components/ui/AppImage';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { blogService, BlogPost } from '@/src/services/blog/blogService';
import RenderHtml from '@/src/components/blog/RenderHtml';
import BlogComments from '@/src/components/blog/BlogComments';
import { Header } from '@/src/components/home/Header';
import { useWebSeo } from '@/src/lib/webSeo';
import { shareOrigin } from '@/src/lib/share';
import { NotFoundView } from '@/src/components/ui/NotFoundView';
import { reportError } from '@/src/lib/reportError';

// SEO canonical points at the authoritative site on purpose — a canonical URL
// must be stable across deployments, so it is NOT the current host.
const SITE_ORIGIN = 'https://tophunt.in';

const stripTags = (html?: string) =>
  (html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const FONT_SANS = Platform.select({
  web: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  default: undefined,
}) as any;
const ACCENT = '#FF3B30';

/**
 * Shared blog post screen, rendered by BOTH /blog/[slug] and the root-level
 * permalink /[slug] (original tophunt.in URLs). The post is resolved from the
 * `slug` route param. Designed as a clean, editorial reading experience.
 *
 * ## `permalink` and why the not-found state depends on it
 *
 * `/blog/<slug>` is unambiguously a blog URL: if the post is gone it was deleted or
 * unpublished, and "Post not found — Browse the blog" is the right answer.
 *
 * The root route is not. `app/[slug].tsx` catches EVERY unknown single-segment
 * path, so `/settings`, `/privacy` or any typo lands here instead of on
 * `app/+not-found.tsx`, and each one was told "Post not found" with the blog as
 * its only exit. Two things were wrong with that: the copy asserts the site once
 * had an article at that address, and — the part that actually costs us — nothing
 * was reported, so a broken internal link to a one-segment path was invisible.
 * Reporting unmatched routes is the entire reason `+not-found.tsx` exists, and
 * this path bypassed it.
 *
 * So on the permalink route an unresolved slug is treated as what it almost always
 * is: a 404. It reports, and it offers home first with the blog as a second
 * option, because an old post permalink is the other real possibility.
 */
interface Props {
  /**
   * True when rendered by the root-level `/[slug]` catch-all rather than
   * `/blog/[slug]`. Passed explicitly instead of inferred from the pathname so the
   * routing decision stays visible in the route file that makes it.
   */
  permalink?: boolean;
}

export default function BlogDetailScreen({ permalink = false }: Props) {
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
      if (data) {
        setPost(data);
      } else {
        setNotFound(true);
        /*
         * Report only the permalink case.
         *
         * On this route an unresolved slug is an unmatched ROUTE, and surfacing
         * those is why `+not-found.tsx` exists — single-segment paths were the one
         * gap in that coverage, so a broken internal link to `/wallets` or
         * `/settings` produced nothing at all.
         *
         * `/blog/<slug>` is deliberately silent: a post that was deleted or
         * unpublished is ordinary content churn, and crawlers hold onto old slugs
         * for months. That would be steady noise carrying no action.
         *
         * `reportError` already dedupes for 10s and caps at 12 events/minute, so a
         * bot walking the URL space cannot turn this into a flood.
         */
        if (permalink) {
          reportError(new Error(`Unmatched route: /${slug}`), {
            screen: 'not-found',
            pathname: `/${slug}`,
            via: 'root-permalink',
          });
        }
      }
      setLoading(false);
    })();
  }, [slug, permalink]);

  const readMins = useMemo(() => {
    const words = (post?.content || '').replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
    return Math.max(1, Math.round(words / 200));
  }, [post]);

  /*
   * Keep the browser tab title + meta in sync on client-side navigation.
   *
   * The not-found branch used to report `title: 'Blog'`, so navigating to a typo
   * left the tab reading "Blog | TopHunt" — announcing a section the user never
   * asked for. There is no `robots` here because there is nothing to set it for:
   * crawlers read the INITIAL html, and the edge Worker already serves
   * `noindex, follow` for an unresolved one-segment path (see
   * `public/_worker.js`). Only a human client-side navigation reaches this.
   */
  useWebSeo(
    useMemo(
      () =>
        post
          ? {
              title: (post as any).metaTitle || post.title,
              description: ((post as any).metaDescription || post.excerpt || stripTags(post.content)).slice(0, 160),
              canonical: `${SITE_ORIGIN}/${post.slug}`,
              image: post.coverImageUrl,
              type: 'article' as const,
            }
          : notFound
            ? { title: 'Page not found', type: 'website' as const }
            : { title: 'Blog', type: 'website' as const },
      [post, notFound],
    ),
  );

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
      // Share the post on whatever host the app is served from — same automatic
      // origin the battle share uses — instead of a hard-coded domain.
      await Share.share({ message: `${post.title}\n\n${shareOrigin()}/${post.slug}` });
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
        permalink ? (
          // An unknown one-segment path: a mistyped or dead link, not a missing
          // article. Home first, blog second — the slug could still be an old
          // tophunt.in post permalink.
          <NotFoundView
            title="This page doesn't exist"
            message="The link you followed may be broken or the page may have moved."
            primary={{ label: 'Go to Home', onPress: () => router.replace('/home') }}
            secondary={{ label: 'Browse the blog', onPress: goToBlog }}
          />
        ) : (
          <NotFoundView
            title="Post not found"
            message="This article may have been removed, or the link may be wrong."
            primary={{ label: 'Browse the blog', onPress: goToBlog }}
            secondary={{ label: 'Go to Home', onPress: () => router.replace('/home') }}
          />
        )
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

              {/* Reader comments. Keyed on the post ROW id, not the slug — and
                  mounted only once a post is resolved, so it never fetches a
                  thread for an article that turned out to be a 404. */}
              <BlogComments postId={post.id} isDark={isDark} />

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
