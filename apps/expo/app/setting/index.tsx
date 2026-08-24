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
} from 'react-native';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useRouter } from 'expo-router';
import { BackButton } from '@/src/components/ui/BackButton';
import { ArrowIcon } from '@/src/components/ui/ArrowIcon';
import {
  Settings_User,
  Settings_Lock,
  Settings_Moon,
  Settings_Help,
  Settings_Community,
  Settings_Document,
  Settings_Info,
  Settings_Logout,
  Settings_Alert,
} from '@/assets/svgs';
import { signOut } from '../../src/services/auth';
import { Colors } from '@/constants/theme';
import {
  setThemePreference,
  useThemePreference,
  type ThemePreference,
} from '@/src/lib/themePreference';
import { emitToast } from '@/src/lib/toastBridge';
import { reportError } from '@/src/lib/reportError';

/**
 * Settings.
 *
 * Nine of the seventeen rows here used to be `onPress: () => {}` — including
 * "Report a Problem" and "Community Guidelines", which matter in a
 * user-generated-content app — and the Dark Mode switch moved without changing
 * anything. Rows now either work or are not shown: an affordance that does
 * nothing is worse than an absent one, because the user assumes the feature is
 * broken rather than missing.
 *
 * Added: Delete Account (required by both app stores) and a real, persisted theme
 * preference.
 */

const THEME_LABELS: Record<ThemePreference, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

export default function SettingScreen() {
  const router = useRouter();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const textColor = isDark ? '#fff' : '#212121';
  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;
  const secondary = isDark ? '#A0A0A0' : '#666';

  const themePreference = useThemePreference();

  /** Cycle system → light → dark. Three states need no extra UI surface. */
  const cycleTheme = () => {
    const next: ThemePreference =
      themePreference === 'system' ? 'light' : themePreference === 'light' ? 'dark' : 'system';
    void setThemePreference(next);
  };

  const performLogout = async () => {
    try {
      await signOut();
      router.replace('/auth/login');
    } catch (error: any) {
      reportError(error, { screen: 'settings', action: 'logout' });
      emitToast(error?.message || 'Could not log out. Please try again.', 'error');
    }
  };

  const handleLogout = () => {
    // Alert.alert is a no-op on web, so confirm there instead of silently doing
    // nothing (or logging the user out with no confirmation).
    if (Platform.OS === 'web') {
      // eslint-disable-next-line no-alert
      if (typeof window !== 'undefined' && !window.confirm('Log out of TopHunt?')) return;
      void performLogout();
      return;
    }
    Alert.alert('Logout', 'Are you sure you want to log out?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Logout', onPress: performLogout, style: 'destructive' },
    ]);
  };

  const renderHeader = () => (
    <View style={styles.header}>
      <BackButton size={24} color={textColor} style={styles.backButton} />
      <Text style={[styles.headerTitle, { color: textColor }]}>Settings</Text>
    </View>
  );

  const renderItem = ({
    icon,
    label,
    onPress,
    rightElement,
    showArrow = true,
    destructive = false,
    accessibilityHint,
  }: {
    icon: any;
    label: string;
    onPress: () => void;
    rightElement?: any;
    showArrow?: boolean;
    destructive?: boolean;
    accessibilityHint?: string;
  }) => (
    <TouchableOpacity
      style={styles.itemContainer}
      onPress={onPress}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
    >
      <View style={styles.itemLeft}>
        <View style={styles.iconContainer}>{icon}</View>
        <Text style={[styles.itemLabel, { color: destructive ? '#FF4D67' : textColor }]}>{label}</Text>
      </View>
      <View style={styles.itemRight}>
        {rightElement}
        {showArrow && <ArrowIcon size={18} direction="right" color={destructive ? '#FF4D67' : textColor} />}
      </View>
    </TouchableOpacity>
  );

  const sectionTitle = (title: string) => (
    <Text style={[styles.sectionTitle, { color: secondary }]}>{title}</Text>
  );

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]}>
      {renderHeader()}
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.contentContainer}>
        {sectionTitle('ACCOUNT')}

        {renderItem({
          icon: <Settings_User width={24} height={24} color={textColor} />,
          label: 'Manage Account',
          onPress: () => router.push('/profile/manage'),
        })}

        {renderItem({
          icon: <Settings_Alert width={24} height={24} color={textColor} />,
          label: 'Notifications',
          onPress: () => router.push('/setting/notifications'),
        })}

        {sectionTitle('PREFERENCES')}

        {renderItem({
          icon: <Settings_Moon width={24} height={24} color={textColor} />,
          label: 'Appearance',
          rightElement: (
            <Text style={[styles.valueText, { color: secondary }]}>{THEME_LABELS[themePreference]}</Text>
          ),
          onPress: cycleTheme,
          showArrow: false,
          accessibilityHint: 'Switches between system, light and dark appearance',
        })}

        {sectionTitle('SUPPORT')}

        {renderItem({
          icon: <Settings_Help width={24} height={24} color={textColor} />,
          label: 'Report a Problem',
          onPress: () => router.push('/setting/report'),
        })}

        {renderItem({
          icon: <Settings_Community width={24} height={24} color={textColor} />,
          label: 'Community Guidelines',
          onPress: () => router.push('/legal/guidelines'),
        })}

        {sectionTitle('LEGAL')}

        {renderItem({
          icon: <Settings_Document width={24} height={24} color={textColor} />,
          label: 'Terms of Service',
          onPress: () => router.push('/legal/terms'),
        })}

        {renderItem({
          icon: <Settings_Lock width={24} height={24} color={textColor} />,
          label: 'Privacy Policy',
          onPress: () => router.push('/legal/privacy'),
        })}

        {renderItem({
          icon: <Settings_Info width={24} height={24} color={textColor} />,
          label: 'Refund Policy',
          onPress: () => router.push('/legal/refund'),
        })}

        <View style={styles.separator} />

        {renderItem({
          icon: <Settings_Logout width={24} height={24} color={textColor} />,
          label: 'Logout',
          showArrow: false,
          onPress: handleLogout,
        })}

        {renderItem({
          icon: <Settings_Alert width={24} height={24} color="#FF4D67" />,
          label: 'Delete Account',
          destructive: true,
          onPress: () => router.push('/setting/delete-account'),
          accessibilityHint: 'Permanently deletes your account and personal data',
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
  sectionTitle: {
    fontSize: 12,
    fontFamily: 'Urbanist-Bold',
    letterSpacing: 1,
    marginTop: 22,
    marginBottom: 4,
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
  valueText: {
    fontSize: 16,
    fontFamily: 'Urbanist-SemiBold',
    marginRight: 6,
  },
  separator: {
    height: 1,
    backgroundColor: 'rgba(128,128,128,0.2)',
    marginTop: 24,
    marginBottom: 4,
  },
});
