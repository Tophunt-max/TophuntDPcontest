import React from 'react';
import { View, FlatList, StyleSheet, Dimensions, Text, ActivityIndicator } from 'react-native';
import { Image } from 'expo-image';
import { Post } from '@/src/types/user';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '@/constants/theme';
import { getOptimizedMediaUrl } from '@/src/utils/media';

type PostGridProps = {
  posts: Post[];
  onLoadMore: () => void;
  isLoading: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  ListHeaderComponent: React.ReactElement;
};

const numColumns = 3;
const { width } = Dimensions.get('window');
const itemSize = width / numColumns;
const blurhash = '|rF?hV%2WCj[ayj[a|j[az_NaeWBj@ayfRayfQfQM{M|azj[azf6fQfQfQIpWXofj[ayj[j[fQayWCoeoeaya}j[ayfQa{oLj?j[WVj[ayayj[fQoff7azayj[ayj[j[ayofayayayj[fQj[ayayj[ayfjj[j[ayjuayj[';

const PostGrid: React.FC<PostGridProps> = ({
  posts,
  onLoadMore,
  isLoading,
  refreshing,
  onRefresh,
  ListHeaderComponent,
}) => {
  const renderItem = ({ item }: { item: Post }) => {
    // Optimized CDN URL for grid thumbnails
    const rawUri = item.mediaUrl || (item as any).imageUrl;
    const imageUri = getOptimizedMediaUrl(rawUri);

    return (
      <View style={styles.itemContainer}>
        <Image 
          source={{ uri: imageUri }} 
          style={styles.itemImage} 
          contentFit="cover"
          transition={200}
          cachePolicy="memory-disk"
          placeholder={blurhash}
        />
        {(item.mediaType === 'video' || item.type === 'video') && (
          <Ionicons name="play" size={24} color="white" style={styles.videoIcon} />
        )}
        <View style={styles.viewsContainer}>
          <Ionicons name="play" size={12} color="white" />
          <Text style={styles.viewsText}>{item.likeCount || 0}</Text>
        </View>
      </View>
    );
  };

  const renderFooter = () => {
    if (!isLoading) return null;
    return <ActivityIndicator style={{ marginVertical: 20 }} size="large" color={Colors.light.primary} />;
  };

  return (
    <FlatList
      data={posts}
      renderItem={renderItem}
      keyExtractor={(item) => item.id}
      numColumns={numColumns}
      ListHeaderComponent={ListHeaderComponent}
      onEndReached={onLoadMore}
      onEndReachedThreshold={0.5}
      ListFooterComponent={renderFooter}
      onRefresh={onRefresh}
      refreshing={refreshing}
      showsVerticalScrollIndicator={false}
    />
  );
};

const styles = StyleSheet.create({
  itemContainer: {
    width: itemSize,
    height: itemSize * 1.5,
    padding: 1,
    position: 'relative',
  },
  itemImage: {
    flex: 1,
    borderRadius: 8,
    backgroundColor: '#F5F5F5'
  },
  videoIcon: {
    position: 'absolute',
    top: 8,
    right: 8,
  },
  viewsContainer: {
    position: 'absolute',
    bottom: 8,
    left: 8,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  viewsText: {
    color: 'white',
    fontSize: 12,
    marginLeft: 4,
  },
});

export default PostGrid;
