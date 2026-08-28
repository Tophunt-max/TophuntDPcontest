import React from 'react';
import { View, Image, Text, TouchableOpacity, StyleSheet, ViewStyle } from 'react-native';
import { Ionicons } from '@/src/lib/icons';
import * as ImagePicker from 'expo-image-picker';
import { useReadjustablePhoto } from '@/src/components/media/useImageAdjuster';

interface AvatarPickerProps {
  uri: string | null;
  onPick: (uri: string) => void;
  style?: ViewStyle;
}

export const AvatarPicker: React.FC<AvatarPickerProps> = ({ uri, onPick, style }) => {
  const { adjustPicked, readjust, canReadjust, host } = useReadjustablePhoto(1);

  const handlePick = async () => {
    // No `allowsEditing`: that crop UI only runs on native. The 1:1 adjuster
    // below crops on every platform, so web users can frame their avatar too.
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 });
    if (result.canceled) return;
    onPick(await adjustPicked(result.assets[0].uri));
  };

  /**
   * Reopen the adjuster on the ORIGINAL pick.
   *
   * Only offered once a photo has been picked in this session: an avatar already
   * on the profile has no original to re-crop from, and re-cropping the stored
   * (already cropped) upload would compound the crop instead of replacing it.
   */
  const handleReadjust = async () => {
    const next = await readjust();
    if (next) onPick(next);
  };

  return (
    <>
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
        {canReadjust && (
          <TouchableOpacity onPress={handleReadjust} style={styles.adjustLink} accessibilityRole="button" accessibilityLabel="Adjust photo">
            <Text style={styles.adjustLinkText}>Adjust photo</Text>
          </TouchableOpacity>
        )}
      </View>
      {host}
    </>
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
  adjustLink: { marginTop: 10, paddingVertical: 4, paddingHorizontal: 10 },
  adjustLinkText: { color: '#FF4D67', fontSize: 13, fontWeight: '700' },
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
