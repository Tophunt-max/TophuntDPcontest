import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  useColorScheme,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Share,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { blogService, BlogPost } from '@/src/services/blog/blogService';
import RenderHtml from '@/src/components/blog/RenderHtml';
import { Colors } from '@/constants/theme';

export default function BlogDetailScreen() {
  const router = useRouter();
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const isDark = useColorScheme() === 'dark';

  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;
  const textColor = isDark ? '#FFFFFF' : '#121212';
  const subTextColor = isDark ? '#A0A0A5' : '#8A8A8E';
  const primaryColor = '#FF3B30';
  const iconBg = isDark ? 'rgba(0,0,0,0.4)' : 'rgba(255,255,255,0.85)';

  const [post, setPost] = useState<BlogPost | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!slug) return;
    (async () => {
      setLoading(true);
      const data = await blogService.getPost(String(slug));
      if (data) setPost(data);
      else setNotFound(true);
      setLoading(false);
    })();
  }, [slug]);

  const onShare = async () => {
    if (!post) return;
    try {
      await Share.share({ message: `${post.title}\n\nhttps://tophunt.in/${post.slug}` });
    } catch {
      /* user cancelled */
    }
  };

  const formatDate = (ts?: number) => {
    if (!ts) return '';
    return new Date(ts).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]}>
      {/* Floating header */}
      <View style={styles.floatingHeader}>
        <TouchableOpacity style={[styles.iconBtn, { backgroundColor: iconBg }]} onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={22} color={textColor} />
        </TouchableOpacity>
        {post && (
          <TouchableOpacity style={[styles.iconBtn, { backgroundColor: iconBg }]} onPress={onShare}>
            <Ionicons name="share-outline" size={22} color={textColor} />
          </TouchableOpacity>
        )}
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={primaryColor} />
        </View>
      ) : notFound || !post ? (
        <View style={styles.center}>
          <Ionicons name="alert-circle-outline" size={48} color={subTextColor} />
          <Text style={{ color: subTextColor, marginTop: 12 }}>Post not found.</Text>
          <TouchableOpacity onPress={() => router.back()} style={{ marginTop: 16 }}>
            <Text style={{ color: primaryColor, fontWeight: '700' }}>Go back</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 60 }}>
          {!!post.coverImageUrl && (
            <Image source={{ uri: post.coverImageUrl }} style={styles.cover} contentFit="cover" transition={200} />
          )}
          <View style={styles.body}>
            {!!post.category && <Text style={[styles.category, { color: primaryColor }]}>{post.category.toUpperCase()}</Text>}
            <Text style={[styles.title, { color: textColor }]}>{post.title}</Text>
            <View style={styles.metaRow}>
              <Text style={[styles.meta, { color: subTextColor }]}>By {post.author || 'TopHunt'}</Text>
              <Text style={[styles.meta, { color: subTextColor }]}>
                {' \u2022 '}
                {formatDate(post.publishedAt || post.createdAt)}
              </Text>
            </View>
            <View style={styles.divider} />
            <RenderHtml html={post.content || ''} isDark={isDark} />

            {Array.isArray(post.tags) && post.tags.length > 0 && (
              <View style={styles.tags}>
                {post.tags.map((t) => (
                  <View key={t} style={[styles.tag, { backgroundColor: isDark ? '#1C1C1E' : '#F2F2F7' }]}>
                    <Text style={[styles.tagText, { color: subTextColor }]}>#{t}</Text>
                  </View>
                ))}
              </View>
            )}
          </View>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  floatingHeader: {
    position: 'absolute',
    top: 44,
    left: 0,
    right: 0,
    zIndex: 20,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
  },
  iconBtn: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  cover: { width: '100%', height: 260 },
  body: { paddingHorizontal: 20, paddingTop: 20 },
  category: { fontSize: 12, fontWeight: '800', letterSpacing: 0.5, marginBottom: 8 },
  title: { fontSize: 28, fontWeight: '800', lineHeight: 36, marginBottom: 12 },
  metaRow: { flexDirection: 'row', alignItems: 'center' },
  meta: { fontSize: 13, fontWeight: '500' },
  divider: { height: 1, backgroundColor: 'rgba(150,150,150,0.2)', marginVertical: 18 },
  tags: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 24, gap: 8 },
  tag: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16 },
  tagText: { fontSize: 13, fontWeight: '600' },
});
