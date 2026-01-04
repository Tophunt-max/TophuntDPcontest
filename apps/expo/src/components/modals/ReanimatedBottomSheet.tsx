import React, { useEffect, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  Dimensions,
  Pressable,
  Platform,
} from "react-native";
import { Portal } from 'react-native-paper';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  runOnJS,
  interpolate,
  Extrapolation,
} from 'react-native-reanimated';
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
} from 'react-native-gesture-handler';

const { height: SCREEN_HEIGHT } = Dimensions.get("window");

interface ReanimatedBottomSheetProps {
  visible: boolean;
  onClose: () => void;
  children: React.ReactNode;
  title?: string;
  maxHeight?: number;
}

export const ReanimatedBottomSheet = ({ 
  visible, 
  onClose, 
  children, 
  title,
  maxHeight = SCREEN_HEIGHT * 0.75 
}: ReanimatedBottomSheetProps) => {
  const translateY = useSharedValue(SCREEN_HEIGHT);
  const opacity = useSharedValue(0);
  const [shouldRender, setShouldRender] = React.useState(false);

  useEffect(() => {
    if (visible) {
      setShouldRender(true);
      translateY.value = withSpring(0, { damping: 20, stiffness: 90 });
      opacity.value = withTiming(1, { duration: 300 });
    } else {
      translateY.value = withSpring(SCREEN_HEIGHT, { damping: 20, stiffness: 90 }, (finished) => {
        if (finished) {
          runOnJS(setShouldRender)(false);
        }
      });
      opacity.value = withTiming(0, { duration: 300 });
    }
  }, [visible]);

  const closeSheet = useCallback(() => {
    translateY.value = withSpring(SCREEN_HEIGHT, { damping: 20, stiffness: 90 }, (finished) => {
      if (finished) {
        runOnJS(onClose)();
        runOnJS(setShouldRender)(false);
      }
    });
    opacity.value = withTiming(0, { duration: 300 });
  }, [onClose]);

  const gesture = Gesture.Pan()
    .onUpdate((event) => {
      if (event.translationY > 0) {
        translateY.value = event.translationY;
      }
    })
    .onEnd((event) => {
      if (event.translationY > 150 || event.velocityY > 500) {
        runOnJS(closeSheet)();
      } else {
        translateY.value = withSpring(0, { damping: 20, stiffness: 90 });
      }
    });

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: interpolate(translateY.value, [0, SCREEN_HEIGHT], [0.5, 0], Extrapolation.CLAMP),
  }));

  if (!shouldRender && !visible) return null;

  return (
    <Portal>
      <GestureHandlerRootView style={StyleSheet.absoluteFill}>
        <Animated.View style={[styles.backdrop, backdropStyle]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={closeSheet} />
        </Animated.View>

        <GestureDetector gesture={gesture}>
          <Animated.View style={[styles.sheetContainer, animatedStyle, { maxHeight }]}>
            <View style={styles.header}>
              <View style={styles.handle} />
              {title && <Text style={styles.headerTitle}>{title}</Text>}
              <View style={styles.divider} />
            </View>
            <View style={styles.content}>
              {children}
            </View>
          </Animated.View>
        </GestureDetector>
      </GestureHandlerRootView>
    </Portal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
  },
  sheetContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 25,
    borderTopRightRadius: 25,
    elevation: 5,
    paddingBottom: Platform.OS === 'ios' ? 34 : 20,
  },
  header: {
    alignItems: 'center',
    paddingTop: 12,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#E0E0E0',
    marginBottom: 16,
  },
  headerTitle: {
    fontFamily: 'Urbanist-Bold',
    fontSize: 18,
    color: '#212121',
    marginBottom: 12,
  },
  divider: {
    height: 1,
    width: '100%',
    backgroundColor: '#EEEEEE',
  },
  content: {
    paddingHorizontal: 24,
    paddingTop: 8,
  },
});
