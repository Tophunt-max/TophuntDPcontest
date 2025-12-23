import React from 'react';
import { View, TouchableOpacity, Text, StyleSheet, Platform, Dimensions } from 'react-native';
import { useRouter, usePathname } from 'expo-router';
import * as Icons from '@/assets/svgs';
import * as Haptics from 'expo-haptics';

const { width } = Dimensions.get('window');

interface BottomNavProps {
    backgroundColor: string;
    isDark: boolean;
}

export const BottomNav = ({ backgroundColor, isDark }: BottomNavProps) => {
  const router = useRouter();
  const pathname = usePathname();

  const activeColor = '#FF4D67';
  const inactiveColor = isDark ? '#757575' : '#9E9E9E';

  const handlePress = (path: string) => {
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    router.push(path);
  };

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
            <CurrentIcon width={26} height={26} color={color} />
            {isActive && <View style={[styles.activeDot, { backgroundColor: activeColor }]} />}
        </View>
        <Text style={[styles.navLabel, { color, fontFamily: isActive ? 'Urbanist-Bold' : 'Urbanist-Medium' }]}>
            {label}
        </Text>
      </TouchableOpacity>
    );
  };

  return (
    <View style={[
        styles.bottomNav, 
        { 
            backgroundColor,
            borderTopColor: isDark ? '#262A35' : '#F1F1F1',
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
            onPress={() => handlePress('/story/create')}
            activeOpacity={0.8}
        >
            <View style={styles.uploadButton}>
                <Icons.Add_Icon width={24} height={24} color="#FFF" />
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
    </View>
  );
};

const styles = StyleSheet.create({
  bottomNav: {
      flexDirection: 'row',
      justifyContent: 'space-around',
      alignItems: 'center',
      height: Platform.OS === 'ios' ? 88 : 70,
      borderTopWidth: 1,
      paddingBottom: Platform.OS === 'ios' ? 25 : 0,
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
      paddingTop: 10,
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
      marginTop: 8,
  },
  addTab: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
  },
  uploadButton: {
      width: 52,
      height: 52,
      borderRadius: 16, // Squircle style
      backgroundColor: '#FF4D67',
      justifyContent: 'center',
      alignItems: 'center',
      marginTop: -30, // Elevated look
      shadowColor: "#FF4D67",
      shadowOffset: { width: 0, height: 6 },
      shadowOpacity: 0.4,
      shadowRadius: 8,
      elevation: 8,
      borderWidth: 4,
      borderColor: 'transparent', // Can be used for extra spacing if needed
  }
});
