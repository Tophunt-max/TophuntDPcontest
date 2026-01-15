import React, { useState, useRef } from 'react';
import { View, TouchableOpacity, Text, StyleSheet, Platform, Dimensions, Modal, TouchableWithoutFeedback, Animated, PanResponder } from 'react-native';
import { useRouter, usePathname } from 'expo-router';
import * as Icons from '@/assets/svgs';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '@/constants/theme';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const { width, height } = Dimensions.get('window');

interface BottomNavProps {
    backgroundColor: string;
    isDark: boolean;
}

export const BottomNav = ({ backgroundColor, isDark }: BottomNavProps) => {
  const router = useRouter();
  const pathname = usePathname();
  const [showAddMenu, setShowAddMenu] = useState(false);
  const insets = useSafeAreaInsets();
  
  const animation = useRef(new Animated.Value(0)).current;
  const panY = useRef(new Animated.Value(0)).current;

  const activeColor = '#FF4D67';
  const inactiveColor = isDark ? '#757575' : '#9E9E9E';

  const triggerHaptic = (style = Haptics.ImpactFeedbackStyle.Medium) => {
    try {
        Haptics.impactAsync(style);
        // Fallback specifically for web browsers that might not respond to expo-haptics
        if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.vibrate) {
            navigator.vibrate(15);
        }
    } catch (error) {
        console.log('Haptic failed', error);
    }
  };

  const handlePress = (path: string) => {
    triggerHaptic();
    if (pathname !== path) {
      router.push(path);
    }
  };

  const closeMenu = () => {
    triggerHaptic(Haptics.ImpactFeedbackStyle.Light);
    Animated.timing(animation, {
        toValue: 0,
        duration: 250,
        useNativeDriver: true,
    }).start(() => {
        setShowAddMenu(false);
        panY.setValue(0);
    });
  };

  const openMenu = () => {
    setShowAddMenu(true);
    triggerHaptic(Haptics.ImpactFeedbackStyle.Medium);
    Animated.spring(animation, {
        toValue: 1,
        friction: 8,
        tension: 40,
        useNativeDriver: true,
    }).start();
  };

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, gestureState) => {
        return gestureState.dy > 10 && Math.abs(gestureState.dx) < 20;
      },
      onPanResponderMove: (_, gestureState) => {
        if (gestureState.dy > 0) {
          panY.setValue(gestureState.dy);
        }
      },
      onPanResponderRelease: (_, gestureState) => {
        if (gestureState.dy > 80 || gestureState.vy > 0.5) {
          closeMenu();
        } else {
          Animated.spring(panY, {
            toValue: 0,
            friction: 8,
            useNativeDriver: true,
          }).start();
        }
      },
    })
  ).current;

  const NavItem = ({ icon: InactiveIcon, activeIcon: ActiveIcon, label, path }: any) => {
    const isActive = pathname === path;
    const color = isActive ? activeColor : inactiveColor;
    const CurrentIcon = isActive ? ActiveIcon : InactiveIcon;

    return (
      <TouchableOpacity 
        style={styles.navItem} 
        onPress={() => handlePress(path)}
        activeOpacity={0.7}
      >
        <View style={styles.iconWrapper}>
            <CurrentIcon width={24} height={24} color={color} />
            {isActive && <View style={[styles.activeDot, { backgroundColor: activeColor }]} />}
        </View>
        <Text style={[styles.navLabel, { color, fontFamily: isActive ? 'Urbanist-Bold' : 'Urbanist-Medium' }]}>
            {label}
        </Text>
      </TouchableOpacity>
    );
  };

  const translateY = Animated.add(
    animation.interpolate({
        inputRange: [0, 1],
        outputRange: [height, 0],
    }),
    panY
  );

  const opacity = animation.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 1],
  });

  return (
    <View style={[
        styles.bottomNav, 
        { 
            backgroundColor,
            borderTopColor: isDark ? '#262A35' : '#F1F1F1',
            paddingBottom: Math.max(insets.bottom, 10),
            height: 60 + Math.max(insets.bottom, 10)
        },
        styles.shadow
    ]}>
        <NavItem 
            icon={Icons.Home_Light} 
            activeIcon={Icons.Home_Dark} 
            label="Home" 
            path="/home" 
        />
        <NavItem 
            icon={Icons.Discover_Light} 
            activeIcon={Icons.Discover_Dark} 
            label="Explore" 
            path="/explore" 
        />
        
        <TouchableOpacity 
            style={styles.addTab} 
            onPress={openMenu}
            activeOpacity={0.8}
        >
            <View style={styles.uploadButton}>
                <Icons.Add_Icon width={22} height={22} color="#FFF" />
            </View>
        </TouchableOpacity>

        <NavItem 
            icon={Icons.Inbox_Light} 
            activeIcon={Icons.Inbox_Dark} 
            label="Inbox" 
            path="/inbox" 
        />
        <NavItem 
            icon={Icons.Profile_Light} 
            activeIcon={Icons.Profile_Dark} 
            label="Profile" 
            path="/profile" 
        />

        <Modal
            visible={showAddMenu}
            transparent
            animationType="none"
            onRequestClose={closeMenu}
        >
            <View style={styles.modalContainer}>
                <TouchableWithoutFeedback onPress={closeMenu}>
                    <Animated.View style={[styles.modalOverlay, { opacity }]} />
                </TouchableWithoutFeedback>
                
                <Animated.View 
                    style={[
                        styles.menuContainer,
                        { 
                            transform: [{ translateY: translateY }],
                            backgroundColor: isDark ? Colors.dark.background : Colors.light.background 
                        }
                    ]}
                    {...panResponder.panHandlers}
                >
                    <View style={styles.dragHandleContainer}>
                        <View style={styles.dragHandle} />
                    </View>
                    
                    <View style={styles.menuHeader}>
                        <Text style={[styles.menuTitle, { color: isDark ? 'white' : 'black' }]}>Create New</Text>
                        <TouchableOpacity onPress={closeMenu} style={styles.closeIcon}>
                            <Ionicons name="close" size={24} color={isDark ? 'white' : 'black'} />
                        </TouchableOpacity>
                    </View>

                    <TouchableOpacity 
                        style={styles.menuItem} 
                        onPress={() => { 
                            triggerHaptic(Haptics.ImpactFeedbackStyle.Medium);
                            closeMenu(); 
                            setTimeout(() => router.push('/contest/photo'), 300); 
                        }}
                    >
                        <View style={[styles.menuIcon, { backgroundColor: '#E8F5E9' }]}>
                            <Ionicons name="image" size={24} color="#4CAF50" />
                        </View>
                        <Text style={[styles.menuText, { color: isDark ? 'white' : 'black' }]}>Photo Contest</Text>
                    </TouchableOpacity>

                    <TouchableOpacity 
                        style={styles.menuItem} 
                        onPress={() => { 
                            triggerHaptic(Haptics.ImpactFeedbackStyle.Medium);
                            closeMenu(); 
                            setTimeout(() => router.push('/contest/video'), 300); 
                        }}
                    >
                        <View style={[styles.menuIcon, { backgroundColor: '#E3F2FD' }]}>
                            <Ionicons name="videocam" size={24} color="#2196F3" />
                        </View>
                        <Text style={[styles.menuText, { color: isDark ? 'white' : 'black' }]}>Video Contest</Text>
                    </TouchableOpacity>

                    <TouchableOpacity 
                        style={styles.menuItem} 
                        onPress={() => { 
                            triggerHaptic(Haptics.ImpactFeedbackStyle.Medium);
                            closeMenu(); 
                            setTimeout(() => router.push('/story/create'), 300); 
                        }}
                    >
                        <View style={[styles.menuIcon, { backgroundColor: '#FFF3E0' }]}>
                            <Ionicons name="star" size={24} color="#FF9800" />
                        </View>
                        <Text style={[styles.menuText, { color: isDark ? 'white' : 'black' }]}>Create Story</Text>
                    </TouchableOpacity>
                </Animated.View>
            </View>
        </Modal>
    </View>
  );
};

const styles = StyleSheet.create({
  bottomNav: {
      flexDirection: 'row',
      justifyContent: 'space-around',
      alignItems: 'center',
      borderTopWidth: 1,
      paddingHorizontal: 10,
  },
  shadow: {
      ...Platform.select({
        ios: {
            shadowColor: '#000',
            shadowOffset: { width: 0, height: -10 },
            shadowOpacity: 0.05,
            shadowRadius: 10,
        },
        android: {
            elevation: 20,
        },
        web: {
            boxShadow: '0px -4px 20px rgba(0, 0, 0, 0.05)',
        }
      })
  },
  navItem: {
      alignItems: 'center',
      justifyContent: 'center',
      flex: 1,
  },
  iconWrapper: {
      alignItems: 'center',
      justifyContent: 'center',
      height: 30,
  },
  activeDot: {
      width: 4,
      height: 4,
      borderRadius: 2,
      marginTop: 4,
      position: 'absolute',
      bottom: -8,
  },
  navLabel: {
      fontSize: 10,
      marginTop: 4,
  },
  addTab: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
  },
  uploadButton: {
      width: 48,
      height: 48,
      borderRadius: 14,
      backgroundColor: '#FF4D67',
      justifyContent: 'center',
      alignItems: 'center',
      marginTop: -25,
      shadowColor: "#FF4D67",
      shadowOffset: { width: 0, height: 6 },
      shadowOpacity: 0.4,
      shadowRadius: 8,
      elevation: 8,
  },
  modalContainer: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  modalOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  menuContainer: {
    padding: 24,
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
  },
  dragHandleContainer: {
    alignItems: 'center',
    marginBottom: 10,
    marginTop: -10,
    paddingVertical: 10,
  },
  dragHandle: {
    width: 40,
    height: 5,
    borderRadius: 3,
    backgroundColor: '#DDD',
  },
  menuHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 24,
  },
  menuTitle: {
    fontSize: 20,
    fontFamily: 'Urbanist-Bold',
  },
  closeIcon: {
    padding: 4,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 20,
  },
  menuIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 16,
  },
  menuText: {
    fontSize: 16,
    fontFamily: 'Urbanist-SemiBold',
  }
});
