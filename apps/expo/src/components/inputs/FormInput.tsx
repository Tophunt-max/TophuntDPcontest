import React, { useState, cloneElement, isValidElement, Children } from 'react';
import { View, TextInput, StyleSheet, Text, ViewStyle, TextInputProps, StyleProp, TextStyle, Platform } from 'react-native';
import { useThemeColor } from '@/hooks/use-theme-color';
import { Control, Controller, FieldValues, Path } from 'react-hook-form';

interface FormInputProps<T extends FieldValues> extends TextInputProps {
  control: Control<T>;
  name: Path<T>;
  placeholder: string;
  icon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  containerStyle?: ViewStyle;
  style?: StyleProp<TextStyle> | StyleProp<ViewStyle>;
}

export const FormInput = <T extends FieldValues>({
  control,
  name,
  placeholder,
  icon,
  rightIcon,
  containerStyle,
  style,
  ...rest
}: FormInputProps<T>) => {
  const [isFocused, setIsFocused] = useState(false);
  const themeBackgroundColor = useThemeColor({}, 'background');
  const textColor = useThemeColor({}, 'text');
  const placeholderColor = '#9E9E9E';

  const focusedBorderColor = '#FF4D67';
  const errorBorderColor = 'red';
  const defaultBorderColor = '#eee';
  const focusedBackgroundColor = '#FFEBEE';
  const errorBackgroundColor = '#FFEBEE';

  return (
    <View style={[styles.container, containerStyle]}>
      <Controller
        control={control}
        name={name}
        render={({ field: { onChange, onBlur, value }, fieldState: { error } }) => {
          const borderColor = error ? errorBorderColor : isFocused ? focusedBorderColor : defaultBorderColor;
          const backgroundColor = error ? errorBackgroundColor : isFocused ? focusedBackgroundColor : themeBackgroundColor;
          const iconColor = error ? errorBorderColor : isFocused ? focusedBorderColor : textColor;

          const iconWithColor = isValidElement(icon)
            ? cloneElement(icon, { color: iconColor } as any)
            : icon;
          
          let rightIconWithColor = rightIcon;
          if (isValidElement(rightIcon) && rightIcon.props.children) {
            const newChildren = Children.map(rightIcon.props.children, child => {
              if (isValidElement(child)) {
                return cloneElement(child, { color: iconColor } as any);
              }
              return child;
            });
            rightIconWithColor = cloneElement(rightIcon, {}, newChildren);
          }
          
          const webStyle = Platform.OS === 'web' ? { boxShadow: `0 0 0 100px ${backgroundColor} inset` } : {};

          return (
            <>
              <View style={[styles.inputWrapper, { backgroundColor: backgroundColor, borderColor: borderColor, borderWidth: 1 }, style]}>
                {icon && <View style={styles.leftIcon}>{iconWithColor}</View>}
                <TextInput
                  style={[styles.input, { color: textColor }, webStyle]}
                  placeholder={placeholder}
                  placeholderTextColor={placeholderColor}
                  onFocus={() => setIsFocused(true)}
                  onBlur={() => {
                    setIsFocused(false);
                    onBlur();
                  }}
                  onChangeText={onChange}
                  value={value}
                  {...rest}
                />
                {rightIcon && <View style={styles.rightIcon}>{rightIconWithColor}</View>}
              </View>
              {error && <Text style={styles.errorText}>{error.message}</Text>}
            </>
          );
        }}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    marginBottom: 16,
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
    borderWidth: 0,
    outlineStyle: 'none',
  },
  errorText: {
    color: 'red',
    fontSize: 12,
    marginTop: 4,
    marginLeft: 4,
  },
});
