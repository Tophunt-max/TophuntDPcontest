import React, { useState, useRef, useEffect } from 'react';
import { View, Text, StyleSheet, Dimensions, TouchableOpacity, useColorScheme } from 'react-native';
import Animated, { 
  useSharedValue, 
  useAnimatedStyle, 
  withTiming, 
  withSpring, 
  Easing, 
  runOnJS 
} from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import Svg, { Path, G, Text as SvgText, TSpan } from 'react-native-svg';

const { width } = Dimensions.get('window');
const WHEEL_SIZE = width * 0.85;
const RADIUS = WHEEL_SIZE / 2;

const REWARDS = [
  { value: 5, color: '#FF4D67', label: '5' },
  { value: 10, color: '#FF8A9B', label: '10' },
  { value: 25, color: '#FFB3C1', label: '25' },
  { value: 0, color: '#757575', label: 'TRY\nAGAIN' },
  { value: 50, color: '#FF4D67', label: '50' },
  { value: 100, color: '#FFC107', label: '100' },
  { value: 15, color: '#FF8A9B', label: '15' },
  { value: 5, color: '#FFB3C1', label: '5' },
];

const NUMBER_OF_SEGMENTS = REWARDS.length;
const SEGMENT_ANGLE = 360 / NUMBER_OF_SEGMENTS;

interface LuckyWheelProps {
    onResult: (value: number) => void;
    canSpin: boolean;
}

export const LuckyWheel = ({ onResult, canSpin }: LuckyWheelProps) => {
  const rotation = useSharedValue(0);
  const [isSpinning, setIsSpinning] = useState(false);
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';

  const spinWheel = () => {
    if (isSpinning || !canSpin) return;

    setIsSpinning(true);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

    // Random rotation (min 5 full spins + random segment)
    const extraDegrees = Math.floor(Math.random() * 360);
    const totalRotation = rotation.value + (360 * 5) + extraDegrees;

    rotation.value = withTiming(totalRotation, {
      duration: 4000,
      easing: Easing.bezier(0.12, 0, 0.33, 1),
    }, (finished) => {
      if (finished) {
        runOnJS(handleSpinEnd)(totalRotation % 360);
      }
    });
  };

  const handleSpinEnd = (finalAngle: number) => {
    setIsSpinning(false);
    
    // Calculate which segment it landed on
    // The wheel rotates clockwise, but index 0 is at 0 degrees
    // Pointer is at top (270 degrees relative to 0)
    const normalizedAngle = (360 - finalAngle + 270) % 360;
    const segmentIndex = Math.floor(normalizedAngle / SEGMENT_ANGLE);
    const result = REWARDS[segmentIndex % NUMBER_OF_SEGMENTS];
    
    onResult(result.value);
  };

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));

  const renderSegments = () => {
    return REWARDS.map((reward, index) => {
      const angle = index * SEGMENT_ANGLE;
      const x1 = RADIUS + RADIUS * Math.cos((Math.PI * (angle - 90)) / 180);
      const y1 = RADIUS + RADIUS * Math.sin((Math.PI * (angle - 90)) / 180);
      const x2 = RADIUS + RADIUS * Math.cos((Math.PI * (angle + SEGMENT_ANGLE - 90)) / 180);
      const y2 = RADIUS + RADIUS * Math.sin((Math.PI * (angle + SEGMENT_ANGLE - 90)) / 180);

      const pathData = `M${RADIUS},${RADIUS} L${x1},${y1} A${RADIUS},${RADIUS} 0 0,1 ${x2},${y2} Z`;

      return (
        <G key={index}>
          <Path d={pathData} fill={reward.color} stroke={isDark ? '#1F222A' : '#FFF'} strokeWidth={2} />
          <G transform={`rotate(${angle + SEGMENT_ANGLE / 2}, ${RADIUS}, ${RADIUS})`}>
            <SvgText
              x={RADIUS}
              y={RADIUS / 3}
              fill="white"
              fontSize="16"
              fontWeight="bold"
              textAnchor="middle"
              transform={`rotate(0, ${RADIUS}, ${RADIUS / 3})`}
            >
                {reward.label.split('\n').map((line, i) => (
                    <TSpan key={i} x={RADIUS} dy={i > 0 ? 15 : 0}>{line}</TSpan>
                ))}
            </SvgText>
          </G>
        </G>
      );
    });
  };

  return (
    <View style={styles.container}>
      {/* Outer Border */}
      <View style={[styles.outerRing, { backgroundColor: isDark ? '#2A2D35' : '#F1F1F1' }]}>
        {/* Lights (Decorative Dots) */}
        {[...Array(12)].map((_, i) => (
            <View 
                key={i} 
                style={[
                    styles.lightDot, 
                    { transform: [{ rotate: `${i * 30}deg` }, { translateY: -WHEEL_SIZE/2 - 5 }] }
                ]} 
            />
        ))}

        <Animated.View style={[styles.wheelContainer, animatedStyle]}>
          <Svg width={WHEEL_SIZE} height={WHEEL_SIZE}>
            {renderSegments()}
            {/* Center Circle */}
            <Path
                d={`M${RADIUS-20},${RADIUS} a20,20 0 1,0 40,0 a20,20 0 1,0 -40,0`}
                fill={isDark ? '#1F222A' : 'white'}
            />
          </Svg>
        </Animated.View>

        {/* Pointer */}
        <View style={styles.pointerContainer}>
            <Ionicons name="caret-down" size={40} color={isDark ? '#FFF' : '#333'} />
        </View>
      </View>

      <TouchableOpacity 
        style={[styles.spinButton, (!canSpin || isSpinning) && styles.disabledButton]} 
        onPress={spinWheel}
        disabled={!canSpin || isSpinning}
      >
        <LinearGradient
            colors={['#FF4D67', '#FF8A9B']}
            style={styles.buttonGradient}
        >
            <Text style={styles.buttonText}>{isSpinning ? 'SPINNING...' : 'SPIN NOW'}</Text>
        </LinearGradient>
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 20,
  },
  outerRing: {
    width: WHEEL_SIZE + 30,
    height: WHEEL_SIZE + 30,
    borderRadius: (WHEEL_SIZE + 30) / 2,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 10,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 10,
    position: 'relative'
  },
  lightDot: {
    position: 'absolute',
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#FFD700',
    top: '50%',
    left: '50%',
    marginLeft: -3,
    marginTop: -3,
  },
  wheelContainer: {
    width: WHEEL_SIZE,
    height: WHEEL_SIZE,
    borderRadius: WHEEL_SIZE / 2,
    overflow: 'hidden',
    backgroundColor: '#FFF',
  },
  pointerContainer: {
    position: 'absolute',
    top: -15,
    zIndex: 10,
  },
  spinButton: {
    marginTop: 30,
    width: width * 0.6,
    height: 55,
    borderRadius: 28,
    overflow: 'hidden',
    elevation: 5,
    shadowColor: '#FF4D67',
    shadowOpacity: 0.3,
    shadowRadius: 8,
  },
  buttonGradient: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: {
    color: 'white',
    fontSize: 18,
    fontFamily: 'Urbanist-Bold',
    letterSpacing: 1,
  },
  disabledButton: {
    opacity: 0.6,
  }
});
