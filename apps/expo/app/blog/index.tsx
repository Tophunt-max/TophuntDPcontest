import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  useColorScheme,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { blogService, BlogPost, BlogCategory } from '@/src/services/blog/blogService';
import { Colors } from '@/constants/theme';

export default function BlogListScreen() {
  const router = useRouter();
  const isDark = useColorScheme() === 'dark';

  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;
  const cardBg = isDark ? '#1C1C1E' : '#FFFFFF';
  const textColor = isDark ? '#FFFFFF' : '#121212';
  const subTextColor = isDark ? '#A0A0A5' : '#8A8A8E';
  const primaryColor = '#FF3B30';
  const chipBg = isDark ? '#1C1C1E' : '#F2F2F7';

  const [posts, setPosts] = useState<BlogPost[]>([]);
  const [categories, setCategories] = useState<BlogCategory[]>([]);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  const load = useCallback(
    async (category: string | null, replace: boolean, cursorParam: number | null = null) => {
      const res = await blogService.getPosts({ category: category || undefined, cursor: cursorParam, limit: 12 });
      setPosts((prev) => (replace ? res.posts : [...prev, ...res.posts]));
      setCursor(res.nextCursor);
      setHasMore(res.nextCursor !== null);
    },
    [],
  );

  useEffect(() => {
    (async () => {
      setLoading(true);
      const cats = await blogService.getCategories();
      setCategories(cats);
      await load(null, true);
      setLoading(false);
    })();
  }, []);

  const onSelectCategory = async (cat: string | null) => {
    if (cat === activeCategory) return;
    setActiveCategory(cat);
    setLoading(true);
    setPosts([]);
    setCursor(null);
    setHasMore(true);
    await load(cat, true);
    setLoading(false);
  };

  const onEndReached = async () => {
    if (loadingMore || !hasMore || loading) return;
    setLoadingMore(true);
    await load(activeCategory, false, cursor);
    setLoadingMore(false);
  };

  const onRefresh = async () => {
    setRefreshing(true);
    setCursor(null);
    setHasMore(true);
    const cats = await blogService.getCategories();
    setCategories(cats);
    await load(activeCategory, true);
    setRefreshing(false);
  };

  const formatDate = (ts?: number) => {
    if (!ts) return '';
    return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const openPost = (post: BlogPost) => {
    router.push({ pathname: '/blog/[slug]', params: { slug: post.slug } });
  };

  const renderItem = ({ item, index }: { item: BlogPost; index: number }) => {
    // First post gets a larger "featured" treatment.
    const featured = index === 0 && !activeCategory;
    return (
      <TouchableOpacity activeOpacity={0.9} style={[styles.card, { backgroundColor: cardBg }]} onPress={() => openPost(item)}>
        {item.coverImageUrl ? (
          <Image
            source={{ uri: item.coverImageUrl }}
            style={featured ? styles.featuredImage : styles.cardImage}
            contentFit="cover"
            transition={200}
          />
        ) : (
          <View style={[featured ? styles.featuredImage : styles.cardImage, styles.placeholder, { backgroundColor: chipBg }]}>
            <Ionicons name="document-text-outline" size={36} color={subTextColor} />
          </View>
        )}
        <View style={styles.cardBody}>
          {!!item.category && <Text style={[styles.category, { color: primaryColor }]}>{item.category.toUpperCase()}</Text>}
          <Text style={[styles.cardTitle, { color: textColor }]} numberOfLines={featured ? 3 : 2}>
            {item.title}
          </Text>
          {!!item.excerpt && (
            <Text style={[styles.excerpt, { color: subTextColor }]} numberOfLines={2}>
              {item.excerpt}
            </Text>
          )}
          <View style={styles.metaRow}>
            <Text style={[styles.meta, { color: subTextColor }]}>{item.author || 'TopHunt'}</Text>
            <Text style={[styles.meta, { color: subTextColor }]}>{formatDate(item.publishedAt || item.createdAt)}</Text>
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  const renderHeader = () => (
    <View>
      <View style={styles.headerRow}>
        <TouchableOpacity style={[styles.iconBtn, { backgroundColor: chipBg }]} onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={22} color={textColor} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: textColor }]}>Blog</Text>
        <View style={{ width: 44 }} />
      </View>

      {categories.length > 0 && (
        <FlatList
          horizontal
          data={[{ category: 'All', count: 0 } as BlogCategory, ...categories]}
          keyExtractor={(c) => c.category}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 14 }}
          renderItem={({ item }) => {
            const value = item.category === 'All' ? null : item.category;
            const active = value === activeCategory;
            return (
              <TouchableOpacity
                onPress={() => onSelectCategory(value)}
                style={[styles.chip, { backgroundColor: active ? primaryColor : chipBg }]}
              >
                <Text style={[styles.chipText, { color: active ? '#FFF' : subTextColor }]}>{item.category}</Text>
              </TouchableOpacity>
            );
          }}
        />
      )}
    </View>
  );

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]}>
      {loading ? (
        <>
          {renderHeader()}
          <View style={styles.center}>
            <ActivityIndicator size="large" color={primaryColor} />
          </View>
        </>
      ) : (
        <FlatList
          data={posts}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          ListHeaderComponent={renderHeader}
          contentContainerStyle={{ paddingBottom: 40 }}
          showsVerticalScrollIndicator={false}
          onEndReached={onEndReached}
          onEndReachedThreshold={0.5}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={primaryColor} />}
          ListEmptyComponent={
            <View style={styles.center}>
              <Ionicons name="newspaper-outline" size={48} color={subTextColor} style={{ opacity: 0.5 }} />
              <Text style={{ color: subTextColor, marginTop: 12 }}>No posts yet.</Text>
            </View>
          }
          ListFooterComponent={
            loadingMore ? <ActivityIndicator style={{ marginVertical: 20 }} color={primaryColor} /> : null
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 80 },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
  },
  iconBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 24, fontWeight: '800' },
  chip: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20, marginRight: 8 },
  chipText: { fontSize: 13, fontWeight: '700' },
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
  cardImage: { width: '100%', height: 170 },
  featuredImage: { width: '100%', height: 220 },
  placeholder: { alignItems: 'center', justifyContent: 'center' },
  cardBody: { padding: 14 },
  category: { fontSize: 11, fontWeight: '800', letterSpacing: 0.5, marginBottom: 6 },
  cardTitle: { fontSize: 18, fontWeight: '700', lineHeight: 24, marginBottom: 6 },
  excerpt: { fontSize: 14, lineHeight: 20, marginBottom: 10 },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between' },
  meta: { fontSize: 12, fontWeight: '500' },
});
