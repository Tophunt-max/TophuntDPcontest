import React from 'react';
import { View, StyleSheet, Animated } from 'react-native';

interface StoriesSkeletonProps {
  isDark?: boolean;
}

export const StoriesSkeleton: React.FC<StoriesSkeletonProps> = ({ isDark = false }) => {
  const pulseAnim = React.useRef(new Animated.Value(0.3)).current;

  React.useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 1000,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 0.3,
          duration: 1000,
          useNativeDriver: true,
        }),
      ])
    ).start();
  }, [pulseAnim]);

  const SkeletonItem = () => (
      <View style={styles.storyContainer}>
         <Animated.View 
            style={[
                styles.storyCircle, 
                { 
                    backgroundColor: isDark ? '#333' : '#E0E0E0',
                    opacity: pulseAnim 
                }
            ]} 
         />
         <Animated.View 
            style={[
                styles.storyText, 
                { 
                    backgroundColor: isDark ? '#333' : '#E0E0E0', 
                    opacity: pulseAnim 
                }
            ]} 
         />
      </View>
  );

  return (
    <View style={styles.container}>
       {[1, 2, 3, 4, 5].map((key) => (
           <SkeletonItem key={key} />
       ))}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    paddingVertical: 10,
    paddingHorizontal: 16,
    marginBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(0,0,0,0.05)',
  },
  storyContainer: {
    alignItems: 'center',
    marginRight: 16,
    width: 72,
  },
  storyCircle: {
      width: 72,
      height: 72,
      borderRadius: 36,
      marginBottom: 6,
  },
  storyText: {
    width: 60,
    height: 10,
    borderRadius: 5,
  }
});
