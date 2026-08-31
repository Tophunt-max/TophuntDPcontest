import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  TouchableOpacity,
  ScrollView,
} from "react-native";
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useRouter } from 'expo-router';
import {
  Settings_User,
  Settings_Lock,
  Settings_Shield,
  Settings_Logout,
} from "@/assets/svgs";
import { BackButton } from "@/src/components/ui/BackButton";
import { ArrowIcon } from "@/src/components/ui/ArrowIcon";
import { signOut } from '../../../src/services/auth';
import { useConfirm } from '@/src/components/modals/ConfirmDialog';
import { emitToast } from '@/src/lib/toastBridge';
import { reportError } from '@/src/lib/reportError';
import { Colors } from '@/constants/theme';

export default function ManageProfileScreen() {
  const router = useRouter();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;
  const textColor = isDark ? Colors.dark.text : Colors.light.text;
  const borderColor = isDark ? '#35383F' : '#EEEEEE';

  const { confirm, dialog: confirmDialog } = useConfirm();

  const performLogout = async () => {
    try {
      await signOut();
      router.replace('/auth/login');
    } catch (error: any) {
      reportError(error, { screen: 'manage-profile', action: 'logout' });
      emitToast(error?.message || 'Could not log out. Please try again.', 'error');
      // Rethrow so the dialog stops its spinner rather than sitting there as if
      // the sign-out were still in flight.
      throw error;
    }
  };

  /**
   * One confirmation on every platform.
   *
   * This used to branch on `Platform.OS === 'web'` and log out IMMEDIATELY there,
   * with no confirmation at all — because a multi-button `Alert.alert` is a no-op
   * in the browser. So the most destructive row on the screen was also the only
   * one that acted on a single mis-tap, and tophunt.in is where most people use
   * this app. `/setting` already solved this with the shared dialog; this screen
   * now uses the same one, which also keeps it up with a spinner while sign-out
   * runs instead of looking idle and inviting a second tap.
   */
  const handleLogout = () => {
    void confirm({
      title: 'Log out?',
      message: 'You will need to sign in again to enter contests or claim rewards.',
      confirmLabel: 'Log out',
      destructive: true,
      onConfirm: performLogout,
    });
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
        {showArrow && <ArrowIcon size={18} direction="right" color={isDestructive ? '#FF4D67' : textColor} />}
      </View>
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]}>
      {confirmDialog}
      {renderHeader()}
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.contentContainer}>
        
        {renderItem({
          icon: Settings_User,
          label: 'Edit Profile',
          onPress: () => router.push('/profile/manage/edit'),
        })}

        {/*
          These two used to BOTH push '/setting'. Different labels, different
          icons, one destination — and that destination had no privacy section and
          hid its only security control (Change Password) for any account without a
          password provider. So a Google- or phone-only user tapping "Security"
          landed on a list with nothing security-related on it.

          They now go to the screens the labels promise.
        */}
        {renderItem({
          icon: Settings_Lock,
          label: 'Privacy Settings',
          onPress: () => router.push('/setting/privacy'),
        })}

        {renderItem({
          icon: Settings_Shield,
          label: 'Security',
          onPress: () => router.push('/setting/security'),
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
