import React from 'react';
import { View, TextInput, StyleSheet, Animated, useColorScheme } from 'react-native';
import { Colors } from '@/constants/theme';
import { Search_Light, Search_Dark, Control } from '@/assets/svgs';

interface SearchBarProps {
  value: string;
  onChangeText: (text: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  interpolatedBackgroundColor: Animated.AnimatedInterpolation<string | number>;
  interpolatedBorderColor: Animated.AnimatedInterpolation<string | number>;
}

export const SearchBar: React.FC<SearchBarProps> = ({ 
  value, 
  onChangeText, 
  onFocus, 
  onBlur, 
  interpolatedBackgroundColor, 
  interpolatedBorderColor 
}) => {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const textColor = isDark ? Colors.dark.text : Colors.light.text;
  const pinkPrimary = '#FF4D67';

  return (
    <Animated.View 
      style={[
        styles.searchSection, 
        { 
          backgroundColor: interpolatedBackgroundColor, 
          borderColor: interpolatedBorderColor, 
          borderWidth: 1 
        }
      ]}
    >
      <View style={{ marginRight: 12 }}>
        {isDark ? <Search_Dark width={20} height={20} /> : <Search_Light width={20} height={20} />}
      </View>
      <TextInput 
        style={[styles.searchInput, { color: textColor }]} 
        placeholder="Search" 
        placeholderTextColor="#9E9E9E"
        value={value} 
        onChangeText={onChangeText} 
        onFocus={onFocus} 
        onBlur={onBlur} 
      />
      <Control width={20} height={20} fill={pinkPrimary} />
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  searchSection: { 
    flexDirection: 'row', 
    alignItems: 'center', 
    borderRadius: 12, 
    paddingHorizontal: 16, 
    marginVertical: 15, 
    height: 56 
  },
  searchInput: { flex: 1, fontSize: 16, height: '100%' },
});
