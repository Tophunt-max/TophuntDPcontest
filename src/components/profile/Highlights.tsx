import React from 'react';
import { View, Text, StyleSheet, Image, FlatList, TouchableOpacity } from 'react-native';

const mockHighlights = [
  { id: '1', name: 'Hangout', image: 'https://picsum.photos/id/10/200' },
  { id: '2', name: 'New Year', image: 'https://picsum.photos/id/20/200' },
  { id: '3', name: 'Friends', image: 'https://picsum.photos/id/30/200' },
  { id: '4', name: 'Beach', image: 'https://picsum.photos/id/40/200' },
  { id: '5', name: 'Party', image: 'https://picsum.photos/id/50/200' },
];

const Highlights = () => {
  const renderItem = ({ item }: { item: typeof mockHighlights[0] }) => (
    <TouchableOpacity style={styles.highlightContainer}>
      <View style={styles.imageWrapper}>
        <Image source={{ uri: item.image }} style={styles.image} />
      </View>
      <Text style={styles.name}>{item.name}</Text>
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      <FlatList
        data={mockHighlights}
        renderItem={renderItem}
        keyExtractor={(item) => item.id}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 16 }}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    paddingVertical: 16,
    backgroundColor: '#fff',
  },
  highlightContainer: {
    alignItems: 'center',
    marginRight: 16,
  },
  imageWrapper: {
    width: 64,
    height: 64,
    borderRadius: 32,
    borderWidth: 2,
    borderColor: '#E1306C', // Instagram-like gradient start color
    justifyContent: 'center',
    alignItems: 'center',
  },
  image: {
    width: 58,
    height: 58,
    borderRadius: 29,
  },
  name: {
    marginTop: 6,
    fontSize: 12,
  },
});

export default Highlights;
