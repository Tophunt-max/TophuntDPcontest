import React from 'react';
import { View, Image, TouchableOpacity, StyleSheet, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';

interface AvatarPickerProps {
  uri: string | null;
  onPick: (uri: string) => void;
  style?: ViewStyle;
}

export const AvatarPicker: React.FC<AvatarPickerProps> = ({ uri, onPick, style }) => {
  const handlePick = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    });

    if (!result.canceled) {
      onPick(result.assets[0].uri);
    }
  };

  return (
    <View style={[styles.container, style]}>
      <TouchableOpacity onPress={handlePick} style={styles.touchable}>
        {uri ? (
          <Image source={{ uri }} style={styles.image} />
        ) : (
          <View style={styles.placeholder}>
             <Ionicons name="person" size={60} color="#BDBDBD" />
          </View>
        )}
        <View style={styles.editBadge}>
          <Ionicons name="pencil" size={14} color="#fff" />
        </View>
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  touchable: {
    position: 'relative',
  },
  image: {
    width: 120,
    height: 120,
    borderRadius: 60,
  },
  placeholder: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: '#F5F5F5',
    alignItems: 'center',
    justifyContent: 'center',
  },
  editBadge: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    backgroundColor: '#FF4D67',
    padding: 8,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: '#fff',
  },
});
