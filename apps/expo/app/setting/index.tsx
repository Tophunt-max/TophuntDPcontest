import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  TouchableOpacity,
  ScrollView,
  Switch,
  useColorScheme,
  Alert,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import {
  Left_Arrow,
  Settings_User,
  Settings_Lock,
  Settings_Shield,
  Settings_Scan,
  Settings_Language,
  Settings_Moon,
  Settings_Video,
  Settings_Ads,
  Settings_Help,
  Settings_Safety,
  Settings_Community,
  Settings_Document,
  Settings_Info,
  Settings_Logout,
  Settings_Alert,
} from "@/assets/svgs";
import { signOut } from '../../src/services/auth';
import { Colors } from '@/constants/theme';

export default function SettingScreen() {
  const router = useRouter();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const textColor = isDark ? '#fff' : '#212121';
  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;

  const [isDarkMode, setIsDarkMode] = useState(isDark);

  const toggleDarkMode = () => setIsDarkMode(previousState => !previousState);

  const performLogout = async () => {
    console.log("[Settings] performLogout: Starting...");
    try {
      await signOut();
      console.log("[Settings] performLogout: Sign out successful");
      
      // Clear navigation stack and go to login
      router.replace('/auth/login');
      
    } catch (error) {
      console.error("[Settings] performLogout: Error:", error);
      if (Platform.OS === 'web') {
        alert("Logout failed: " + error.message);
      } else {
        Alert.alert("Error", "Failed to logout. Please try again.");
      }
    }
  };

  const handleLogout = () => {
    console.log("[Settings] handleLogout called");
    
    if (Platform.OS === 'web') {
      // Direct logout for web to avoid window.confirm issues for now
      performLogout();
    } else {
      Alert.alert(
        "Logout",
        "Are you sure you want to log out?",
        [
          { text: "Cancel", style: "cancel", onPress: () => console.log("[Settings] Logout cancelled") },
          { text: "Logout", onPress: performLogout, style: "destructive" }
        ]
      );
    }
  };

  const renderHeader = () => (
    <View style={styles.header}>
      <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
        <Left_Arrow width={24} height={24} color={textColor} />
      </TouchableOpacity>
      <Text style={[styles.headerTitle, { color: textColor }]}>Setting</Text>
    </View>
  );

  const renderItem = ({ icon, label, onPress, rightElement, showArrow = true }) => (
    <TouchableOpacity 
      style={styles.itemContainer} 
      onPress={() => {
        console.log(`[Settings] Item pressed: ${label}`);
        onPress();
      }}
      activeOpacity={0.7}
    >
      <View style={styles.itemLeft}>
        <View style={styles.iconContainer}>
            {icon}
        </View>
        <Text style={[styles.itemLabel, { color: textColor }]}>{label}</Text>
      </View>
      <View style={styles.itemRight}>
        {rightElement}
        {showArrow && <Ionicons name="chevron-forward" size={20} color={textColor} />}
      </View>
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]}>
      {renderHeader()}
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.contentContainer}>
        
        {renderItem({
          icon: <Settings_User width={24} height={24} color={textColor} />,
          label: 'Manage Account',
          onPress: () => router.push('/profile/manage'),
        })}

        {renderItem({
          icon: <Settings_Lock width={24} height={24} color={textColor} />,
          label: 'Privacy',
          onPress: () => router.push('/legal/privacy'),
        })}

        {renderItem({
          icon: <Settings_Shield width={24} height={24} color={textColor} />,
          label: 'Security',
          onPress: () => {},
        })}

        {renderItem({
          icon: <Settings_Scan width={24} height={24} color={textColor} />,
          label: 'QR Code',
          onPress: () => {},
        })}

        {renderItem({
          icon: <Settings_Language width={24} height={24} color={textColor} />,
          label: 'Language',
          rightElement: <Text style={[styles.languageText, { color: isDark ? '#E0E0E0' : '#212121' }]}>English(US)</Text>,
          onPress: () => {},
        })}

        {renderItem({
          icon: <Settings_Moon width={24} height={24} color={textColor} />,
          label: 'Dark Mode',
          showArrow: false,
          rightElement: (
            <Switch
              trackColor={{ false: '#767577', true: '#FF4D67' }}
              thumbColor={'#f4f3f4'}
              ios_backgroundColor="#3e3e3e"
              onValueChange={toggleDarkMode}
              value={isDarkMode}
            />
          ),
          onPress: toggleDarkMode,
        })}

        {renderItem({
          icon: <Settings_Video width={24} height={24} color={textColor} />,
          label: 'Content Preferences',
          onPress: () => {},
        })}

        {renderItem({
          icon: <Settings_Ads width={24} height={24} color={textColor} />,
          label: 'Ads',
          onPress: () => {},
        })}

        {renderItem({
          icon: <Settings_Help width={24} height={24} color={textColor} />,
          label: 'Report a Problem',
          onPress: () => {},
        })}

        {renderItem({
          icon: <Settings_Info width={24} height={24} color={textColor} />,
          label: 'Help Center',
          onPress: () => {},
        })}

        {renderItem({
          icon: <Settings_Safety width={24} height={24} color={textColor} />,
          label: 'Safety Center',
          onPress: () => {},
        })}

        {renderItem({
          icon: <Settings_Community width={24} height={24} color={textColor} />,
          label: 'Community Guidelines',
          onPress: () => {},
        })}

        {renderItem({
          icon: <Settings_Document width={24} height={24} color={textColor} />,
          label: 'Terms of Services',
          onPress: () => router.push('/legal/terms'),
        })}

        {renderItem({
          icon: <Settings_Alert width={24} height={24} color={textColor} />,
          label: 'Privacy Policy',
          onPress: () => router.push('/legal/privacy'),
        })}

        {renderItem({
          icon: <Settings_Logout width={24} height={24} color={textColor} />,
          label: 'Logout',
          showArrow: false,
          onPress: handleLogout,
        })}

      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 15,
  },
  backButton: {
    marginRight: 15,
  },
  headerTitle: {
    fontSize: 24,
    fontFamily: 'Urbanist-Bold',
  },
  contentContainer: {
    paddingHorizontal: 20,
    paddingBottom: 30,
  },
  itemContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 15,
  },
  itemLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  iconContainer: {
    marginRight: 15,
    width: 24,
    height: 24,
    justifyContent: 'center',
    alignItems: 'center',
  },
  itemLabel: {
    fontSize: 18,
    fontFamily: 'Urbanist-SemiBold',
  },
  itemRight: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  languageText: {
    fontSize: 16,
    fontFamily: 'Urbanist-SemiBold',
    marginRight: 10,
  },
});
