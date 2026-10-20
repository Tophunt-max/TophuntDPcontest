import React, { useRef } from 'react';
import { Animated as RNAnimated, Pressable } from 'react-native';

/**
 * Pressable that gently scales down on press for a tactile, premium feel.
 *
 * Extra props are forwarded to the `Pressable`, so a caller can attach
 * accessibility attributes. Without that they would land on the outer animated
 * wrapper instead of the element that is actually focusable, and a screen reader
 * would announce a card with no name.
 */
export function ScaleTouchable({ children, onPress, style, disabled, ...rest }: any) {
  const scale = useRef(new RNAnimated.Value(1)).current;
  return (
    <RNAnimated.View style={[style, { transform: [{ scale }] }]}>
      <Pressable
        onPress={onPress}
        disabled={disabled}
        onPressIn={() => RNAnimated.spring(scale, { toValue: 0.95, useNativeDriver: true, speed: 50, bounciness: 0 }).start()}
        onPressOut={() => RNAnimated.spring(scale, { toValue: 1, useNativeDriver: true, speed: 50, bounciness: 4 }).start()}
        style={{ flex: 1 }}
        {...rest}
      >
        {children}
      </Pressable>
    </RNAnimated.View>
  );
}

