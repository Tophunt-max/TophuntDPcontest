import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  TouchableOpacity,
  ScrollView,
  Alert,
  Platform,
  useColorScheme,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@/src/lib/icons';
import {
  Settings_User,
  Settings_Lock,
  Settings_Shield,
  Settings_Logout,
} from "@/assets/svgs";
import { BackButton } from "@/src/components/ui/BackButton";
import { signOut } from '../../../src/services/auth';
import { Colors } from '@/constants/theme';

export default function ManageProfileScreen() {
  const router = useRouter();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;
  const textColor = isDark ? Colors.dark.text : Colors.light.text;
  const borderColor = isDark ? '#35383F' : '#EEEEEE';

  const performLogout = async () => {
    try {
      await signOut();
      router.replace('/auth/login');
    } catch (error: any) {
      console.error("Logout error:", error);
      Alert.alert("Error", "Failed to logout. Please try again.");
    }
  };

  const handleLogout = () => {
    if (Platform.OS === 'web') {
      performLogout();
    } else {
      Alert.alert(
        "Logout",
        "Are you sure you want to log out?",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Logout", onPress: performLogout, style: "destructive" }
        ]
      );
    }
  };

  const renderHeader = () => (
    <View style={styles.header}>
      <BackButton size={24} color={textColor} style={styles.backButton} />
      <Text style={[styles.headerTitle, { color: textColor }]}>Manage Profile</Text>
    </View>
  );

  const renderItem = ({ icon: Icon, label, onPress, showArrow = true, isDestructive = false }: any) => (
    <TouchableOpacity 
      style={[styles.itemContainer, { borderBottomColor: borderColor }]} 
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={styles.itemLeft}>
        <View style={styles.iconContainer}>
          <Icon width={24} height={24} color={isDestructive ? '#FF4D67' : textColor} />
        </View>
        <Text style={[styles.itemLabel, { color: isDestructive ? '#FF4D67' : textColor }]}>{label}</Text>
      </View>
      <View style={styles.itemRight}>
        {showArrow && <Ionicons name="chevron-forward" size={20} color={isDestructive ? '#FF4D67' : textColor} />}
      </View>
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]}>
      {renderHeader()}
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.contentContainer}>
        
        {renderItem({
          icon: Settings_User,
          label: 'Edit Profile',
          onPress: () => router.push('/profile/manage/edit'),
        })}

        {renderItem({
          icon: Settings_Lock,
          label: 'Privacy Settings',
          onPress: () => router.push('/setting'),
        })}

        {renderItem({
          icon: Settings_Shield,
          label: 'Security',
          onPress: () => router.push('/setting'),
        })}

        {renderItem({
          icon: Settings_Logout,
          label: 'Logout',
          showArrow: false,
          isDestructive: true,
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
    paddingVertical: 20,
    borderBottomWidth: 1,
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
});
