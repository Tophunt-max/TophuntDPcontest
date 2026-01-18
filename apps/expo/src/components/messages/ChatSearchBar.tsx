import React, { useState } from 'react';
import { View, TextInput, StyleSheet, TouchableOpacity, useColorScheme, Platform } from 'react-native';
import { Colors } from '@/constants/theme';
import { Search_Light, Search_Dark } from '@/assets/svgs';
import { Ionicons } from '@expo/vector-icons';

interface ChatSearchBarProps {
  value: string;
  onChangeText: (text: string) => void;
  onClose: () => void;
}

export const ChatSearchBar: React.FC<ChatSearchBarProps> = ({ value, onChangeText, onClose }) => {
  const [isFocused, setIsFocused] = useState(false);
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  
  const themeBackgroundColor = isDark ? Colors.dark.background : Colors.light.background;
  const textColor = isDark ? Colors.dark.text : Colors.light.text;
  
  const focusedBorderColor = '#FF4D67';
  const defaultBorderColor = isDark ? '#35383F' : '#eee';
  const focusedBackgroundColor = isDark ? '#2D1F22' : '#FFEBEE';
  const backgroundColor = isFocused ? focusedBackgroundColor : themeBackgroundColor;
  const borderColor = isFocused ? focusedBorderColor : defaultBorderColor;

  return (
    <View style={styles.container}>
      <View style={[styles.inputWrapper, { backgroundColor, borderColor, borderWidth: 1 }]}>
        <View style={styles.leftIcon}>
          {isDark ? (
            <Search_Dark width={20} height={20} color={isFocused ? '#FF4D67' : textColor} />
          ) : (
            <Search_Light width={20} height={20} color={isFocused ? '#FF4D67' : textColor} />
          )}
        </View>
        <TextInput 
          style={[
            styles.input, 
            { color: textColor },
            Platform.OS === 'web' && ({ outlineStyle: 'none' } as any)
          ]} 
          placeholder="Search messages..." 
          placeholderTextColor="#9E9E9E"
          value={value} 
          onChangeText={onChangeText}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          autoFocus
        />
        <TouchableOpacity onPress={onClose} style={styles.rightIcon}>
          <Ionicons name="close-circle" size={20} color={isFocused ? '#FF4D67' : '#9E9E9E'} />
        </TouchableOpacity>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 15,
    marginVertical: 10,
    width: '100%',
  },
  inputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 56,
    borderRadius: 12,
    paddingHorizontal: 16,
  },
  leftIcon: {
    marginRight: 12,
  },
  rightIcon: {
    marginLeft: 12,
  },
  input: {
    flex: 1,
    fontSize: 16,
    height: '100%',
    ...Platform.select({
      web: {
        outlineStyle: 'none',
      },
    }),
  },
});
