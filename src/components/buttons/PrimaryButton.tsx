import React from 'react';
import { TouchableOpacity, Text, StyleSheet, ActivityIndicator, ViewStyle, TextStyle } from 'react-native';
import { useThemeColor } from '@/hooks/use-theme-color';

interface PrimaryButtonProps {
  title: string;
  onPress: () => void;
  isLoading?: boolean;
  style?: ViewStyle;
  textStyle?: TextStyle;
  disabled?: boolean;
  variant?: 'primary' | 'outline' | 'ghost';
}

export const PrimaryButton: React.FC<PrimaryButtonProps> = ({
  title,
  onPress,
  isLoading = false,
  style,
  textStyle,
  disabled = false,
  variant = 'primary'
}) => {
  const backgroundColor = variant === 'primary' ? '#FF4D67' : 'transparent';
  const borderColor = variant === 'outline' ? '#FF4D67' : 'transparent';
  const textColor = variant === 'primary' ? '#fff' : '#FF4D67';

  return (
    <TouchableOpacity
      style={[
        styles.container,
        { backgroundColor, borderColor, borderWidth: variant === 'outline' ? 1 : 0 },
        disabled && styles.disabled,
        style,
      ]}
      onPress={onPress}
      disabled={disabled || isLoading}
      activeOpacity={0.8}
    >
      {isLoading ? (
        <ActivityIndicator color={textColor} />
      ) : (
        <Text style={[styles.text, { color: textColor }, textStyle]}>{title}</Text>
      )}
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  container: {
    height: 56,
    borderRadius: 30,
    justifyContent: 'center',
    alignItems: 'center',
    width: '100%',
    shadowColor: '#FF4D67',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 4,
  },
  text: {
    fontSize: 16,
    fontFamily: 'Urbanist-Bold',
  },
  disabled: {
    opacity: 0.6,
  },
});
