import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  TouchableOpacity,
  ScrollView,
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
  Settings_Shield,
} from '@/assets/svgs';
// Two rows need glyphs the `settings/*.svg` set does not carry a themeable
// version of. `notification.svg` and `delete_icon.svg` exist but both hardcode
// `stroke="white"`, so they are invisible in light mode and cannot take the
// destructive red — the lucide shim themes correctly via `color`.
import { Ionicons } from '@/src/lib/icons';
import { signOut } from '../../src/services/auth';
import { useConfirm } from '@/src/components/modals/ConfirmDialog';
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
 *
 * Keep every row's icon distinct. Three rows once rendered the same alert circle
 * (Notifications, Refund Policy, Delete Account) and two rendered the same
 * padlock (Blocked & Muted, Privacy Policy). A duplicated glyph costs more than
 * it looks: the icon column stops being something you can scan and the eye has
 * to fall back to reading every label.
 */

const THEME_LABELS: Record<ThemePreference, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

/**
 * Appearance options, shown as an expanding list rather than applied by cycling
 * the row.
 *
 * Tapping the row used to advance system -> light -> dark. That hid the feature
 * twice over: the row carried no affordance saying it was interactive, and
 * nothing revealed that a third option existed — reaching `dark` from `light`
 * meant tapping twice and passing through a state you did not want, with the
 * whole app repainting each time. A disclosure list states the options up front
 * and each tap is the choice itself.
 */
const THEME_OPTIONS: { value: ThemePreference; hint?: string }[] = [
  { value: 'system', hint: 'Match my device setting' },
  { value: 'light' },
  { value: 'dark' },
];

export default function SettingScreen() {
  const router = useRouter();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const textColor = isDark ? '#fff' : '#212121';
  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;
  const secondary = isDark ? '#A0A0A0' : '#666';

  const themePreference = useThemePreference();
  const [appearanceOpen, setAppearanceOpen] = useState(false);

  const chooseTheme = (next: ThemePreference) => {
    void setThemePreference(next);
    // Collapse on choose: the row's value text now shows the result, so leaving
    // the list open would just repeat what the user can already see.
    setAppearanceOpen(false);
  };

  const { confirm, dialog: confirmDialog } = useConfirm();

  const performLogout = async () => {
    try {
      await signOut();
      router.replace('/auth/login');
    } catch (error: any) {
      reportError(error, { screen: 'settings', action: 'logout' });
      emitToast(error?.message || 'Could not log out. Please try again.', 'error');
      // Rethrow so the dialog stops its spinner and closes rather than sitting
      // there as if the sign-out were still in flight.
      throw error;
    }
  };

  /**
   * One confirmation for both platforms.
   *
   * This used to branch: `Alert.alert` on native (fine) and `window.confirm` on
   * web, because a multi-button Alert is a no-op there. The browser dialog worked
   * but was unstyleable, announced the hostname, and could not stay open while
   * the sign-out request ran — so the screen looked idle and invited a second tap.
   * `onConfirm` keeps the dialog up with a spinner until sign-out finishes.
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
      {confirmDialog}
      {renderHeader()}
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.contentContainer}>
        {sectionTitle('ACCOUNT')}

        {renderItem({
          icon: <Settings_User width={24} height={24} color={textColor} />,
          label: 'Manage Account',
          onPress: () => router.push('/profile/manage'),
        })}

        {renderItem({
          // A bell, not the alert circle this used to share with Refund Policy and
          // Delete Account — three rows rendered the same glyph.
          icon: <Ionicons name="notifications-outline" size={24} color={textColor} />,
          label: 'Notifications',
          onPress: () => router.push('/setting/notifications'),
        })}

        {/*
          The durable route back to a blocked account. Once blocked, someone no
          longer appears in search, suggestions or any feed, so the profile you
          blocked them from is usually unreachable — without this list the action
          would be effectively irreversible.
        */}
        {renderItem({
          icon: <Settings_Lock width={24} height={24} color={textColor} />,
          label: 'Blocked & Muted',
          onPress: () => router.push('/setting/blocked'),
          accessibilityHint: 'Review and undo accounts you have blocked or muted',
        })}

        {sectionTitle('PREFERENCES')}

        {renderItem({
          icon: <Settings_Moon width={24} height={24} color={textColor} />,
          label: 'Appearance',
          rightElement: (
            <>
              <Text style={[styles.valueText, { color: secondary }]}>
                {THEME_LABELS[themePreference]}
              </Text>
              <Ionicons
                name={appearanceOpen ? 'chevron-up' : 'chevron-down'}
                size={18}
                color={textColor}
              />
            </>
          ),
          onPress: () => setAppearanceOpen((open) => !open),
          showArrow: false,
          accessibilityHint: appearanceOpen
            ? 'Collapses the appearance options'
            : 'Shows the system, light and dark appearance options',
        })}

        {appearanceOpen && (
          // `radiogroup` rather than a list of buttons, so a screen reader
          // announces these as one choice with three mutually exclusive options.
          <View style={styles.themeOptions} accessibilityRole="radiogroup">
            {THEME_OPTIONS.map(({ value, hint }) => {
              const active = themePreference === value;
              return (
                <TouchableOpacity
                  key={value}
                  style={styles.themeOption}
                  onPress={() => chooseTheme(value)}
                  activeOpacity={0.7}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={THEME_LABELS[value]}
                  accessibilityHint={hint}
                >
                  <View style={styles.themeOptionText}>
                    <Text
                      style={[styles.themeOptionLabel, { color: active ? '#FF4D67' : textColor }]}
                    >
                      {THEME_LABELS[value]}
                    </Text>
                    {!!hint && (
                      <Text style={[styles.themeOptionHint, { color: secondary }]}>{hint}</Text>
                    )}
                  </View>
                  {active && <Ionicons name="checkmark" size={20} color="#FF4D67" />}
                </TouchableOpacity>
              );
            })}
          </View>
        )}

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
          // A shield. The padlock here was the same asset as "Blocked & Muted",
          // and the two rows sit close enough to read as related.
          icon: <Settings_Shield width={24} height={24} color={textColor} />,
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
          // A bin. An alert circle reads as "warning", which is also what the
          // Notifications row showed — this row deletes, and should look like it.
          icon: <Ionicons name="trash-outline" size={24} color="#FF4D67" />,
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
  // Indented to the icon column's inner edge (24 icon + 15 gap) so the options
  // read as belonging to the Appearance row above them rather than as new rows.
  themeOptions: {
    paddingLeft: 39,
  },
  themeOption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
  },
  themeOptionText: {
    flex: 1,
  },
  themeOptionLabel: {
    fontSize: 16,
    fontFamily: 'Urbanist-SemiBold',
  },
  themeOptionHint: {
    fontSize: 12,
    fontFamily: 'Urbanist-Regular',
    marginTop: 2,
  },
  separator: {
    height: 1,
    backgroundColor: 'rgba(128,128,128,0.2)',
    marginTop: 24,
    marginBottom: 4,
  },
});
