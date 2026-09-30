import React from 'react';
import { View, FlatList, Image, StyleSheet, Text, ActivityIndicator } from 'react-native';
import { Post } from '@/src/types/user';
import { Ionicons } from '@/src/lib/icons';
import { Colors } from '@/constants/theme';
import { useDesignWindow } from '@/src/lib/layout';

type PostGridProps = {
  posts: Post[];
  onLoadMore: () => void;
  isLoading: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  ListHeaderComponent: React.ReactElement;
};

const numColumns = 3;

const PostGrid: React.FC<PostGridProps> = ({
  posts,
  onLoadMore,
  isLoading,
  refreshing,
  onRefresh,
  ListHeaderComponent,
}) => {
  // Column width, not browser width: on desktop the app sits in a phone column.
  const { width } = useDesignWindow();
  const itemSize = width / numColumns;
  const renderItem = ({ item }: { item: Post }) => (
    <View style={[styles.itemContainer, { width: itemSize, height: itemSize * 1.5 }]}>
      <Image source={{ uri: item.mediaUrl }} style={styles.itemImage} />
      {item.mediaType === 'video' && (
        <Ionicons name="play" size={24} color="white" style={styles.videoIcon} />
      )}
      <View style={styles.viewsContainer}>
        <Ionicons name="play" size={12} color="white" />
        <Text style={styles.viewsText}>21.2M</Text>
      </View>
    </View>
  );

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
    // width / height (rectangular, 1.5x) are applied inline from the window size.
    padding: 1,
    position: 'relative',
  },
  itemImage: {
    flex: 1,
    borderRadius: 8,
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
