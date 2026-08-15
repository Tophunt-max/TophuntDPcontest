import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Image, FlatList, TouchableOpacity, ActivityIndicator } from 'react-native';
import { fetchUserHighlights } from '@/src/services/stories/storyService';
import { Ionicons } from '@/src/lib/icons';
import { useRouter } from 'expo-router';
import { useAuth } from '@/src/services/auth';

interface HighlightsProps {
  userId: string;
}

const Highlights: React.FC<HighlightsProps> = ({ userId }) => {
  const [highlights, setHighlights] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const { user } = useAuth();
  const isMyProfile = user?.uid === userId;

  useEffect(() => {
    loadHighlights();
  }, [userId]);

  const loadHighlights = async () => {
    setLoading(true);
    const data = await fetchUserHighlights(userId);
    setHighlights(data);
    setLoading(false);
  };

  const handleHighlightPress = (highlightId: string) => {
      router.push({
          pathname: `/story/highlight/${userId}`,
          params: { highlightId }
      });
  };

  const renderItem = ({ item }: { item: any }) => (
    <TouchableOpacity 
        style={styles.highlightContainer}
        onPress={() => handleHighlightPress(item.id)}
    >
      <View style={styles.imageWrapper}>
        <Image source={{ uri: item.coverImageUrl }} style={styles.image} />
      </View>
      <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
    </TouchableOpacity>
  );

  if (loading) {
    return (
        <View style={styles.loaderContainer}>
            <ActivityIndicator size="small" color="#ff4466" />
        </View>
    );
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={highlights}
        renderItem={renderItem}
        keyExtractor={(item) => item.id}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 16 }}
        ListHeaderComponent={
            isMyProfile ? (
                <TouchableOpacity 
                    style={styles.highlightContainer}
                    onPress={() => router.push('/story/create')}
                >
                    <View style={[styles.imageWrapper, styles.addWrapper]}>
                        <Ionicons name="add" size={30} color="#212121" />
                    </View>
                    <Text style={styles.name}>New</Text>
                </TouchableOpacity>
            ) : null
        }
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    paddingVertical: 16,
    backgroundColor: 'transparent',
  },
  loaderContainer: {
      height: 100,
      justifyContent: 'center',
      alignItems: 'center'
  },
  highlightContainer: {
    alignItems: 'center',
    marginRight: 16,
    width: 70,
  },
  imageWrapper: {
    width: 64,
    height: 64,
    borderRadius: 32,
    borderWidth: 1,
    borderColor: '#DBDBDB',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 2,
  },
  addWrapper: {
      borderStyle: 'dashed',
      borderColor: '#999',
  },
  image: {
    width: '100%',
    height: '100%',
    borderRadius: 30,
  },
  name: {
    marginTop: 6,
    fontSize: 12,
    fontFamily: 'Urbanist-Medium',
    color: '#212121',
    textAlign: 'center',
  },
});

export default Highlights;
