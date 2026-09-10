import React from 'react';
import {
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { BackButton } from '@/src/components/ui/BackButton';
import { ArrowIcon } from '@/src/components/ui/ArrowIcon';
import { Ionicons } from '@/src/lib/icons';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/src/hooks/useAuth';
import { logoutAllDevices, signOut } from '@/src/services/auth';
import {
  hasPasswordProvider,
  providerIdsFor,
  describePasswordlessAccount,
} from '@/src/services/auth/changePassword';
import { providerLabel } from '@/src/services/auth/passwordReset';
import { useConfirm } from '@/src/components/modals/ConfirmDialog';
import { emitToast } from '@/src/lib/toastBridge';
import { reportError } from '@/src/lib/reportError';
import { stripErrorMarker } from '@/src/lib/stripErrorMarker';

/**
 * Security.
 *
 * ## Why this screen exists
 *
 * "Security" on Manage Profile pushed `/setting` — the same destination as the
 * "Privacy Settings" row directly above it. Worse, the nearest thing to a security
 * control on that screen, Change Password, is hidden for accounts with no password
 * provider. So a Google- or phone-only user tapping "Security" arrived at a list
 * containing no security controls at all and no explanation.
 *
 * ## The rule this screen follows
 *
 * The Settings screen's policy is that a row either works or is not rendered. That
 * is right for a list of features, but wrong for the *only* screen a user will look
 * at when they are worried about their account: "there is nothing here" is not an
 * answer to "is my account safe". So instead of hiding what does not apply, this
 * screen states what protects the account and, where a control is unavailable,
 * explains why in place of it.
 *
 * Concretely: an account with no password shows a paragraph naming the provider
 * that holds its credentials, instead of an absent row.
 */
export default function SecurityScreen() {
  const router = useRouter();
  const isDark = useColorScheme() === 'dark';
  const textColor = isDark ? '#fff' : '#212121';
  const subTextColor = isDark ? '#9E9E9E' : '#616161';
  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;
  const cardColor = isDark ? '#1F222A' : '#F7F7F9';
  const borderColor = isDark ? '#35383F' : '#EEEEEE';

  const { user } = useAuth();
  const { confirm, dialog: confirmDialog } = useConfirm();

  const canChangePassword = hasPasswordProvider(user);
  const providers = providerIdsFor(user).map(providerLabel);
  const signInMethods = providers.length > 0 ? providers.join(', ') : 'Not signed in';

  const performLogout = async () => {
    try {
      await signOut();
      router.replace('/auth/login');
    } catch (error: any) {
      reportError(error, { screen: 'security', action: 'logout' });
      emitToast(error?.message || 'Could not log out. Please try again.', 'error');
      // Rethrow so the dialog stops its spinner rather than sitting there as if
      // the sign-out were still running.
      throw error;
    }
  };

  const handleLogout = () => {
    void confirm({
      title: 'Log out?',
      message: 'You will need to sign in again to enter contests or claim rewards.',
      confirmLabel: 'Log out',
      destructive: true,
      onConfirm: performLogout,
    });
  };

  const performLogoutAll = async () => {
    try {
      await logoutAllDevices();
      router.replace('/auth/login');
      emitToast('Signed out on all devices.', 'success');
    } catch (error: any) {
      reportError(error, { screen: 'security', action: 'logoutAllDevices' });
      // Deliberately does NOT fall back to a local-only sign-out. Someone who pressed
      // this because they think an intruder is signed in must not be left believing the
      // intruder was removed when the request never landed — being signed out here while
      // they are still signed in there is the worst of both outcomes. The session is
      // untouched, so retrying is all that is needed.
      // `error.message` can be a server message carrying the machine marker
      // (`session_revoked: …`), which happens if this session was already revoked — by
      // pressing twice, or by another device. Stripped rather than shown raw.
      emitToast(
        stripErrorMarker(error?.message) || 'Could not sign out your other devices. Please try again.',
        'error',
      );
      throw error;
    }
  };

  const handleLogoutAll = () => {
    void confirm({
      title: 'Log out of all devices?',
      /**
       * States plainly that this device goes too.
       *
       * It is not a caveat to bury — it is the difference between the control doing what
       * it claims and not. A cutoff cannot preserve one session without being able to
       * identify it, and for the case this exists to answer — "I do not know who else is
       * signed in" — ending everything is the only answer that actually settles the
       * question. Saying so up front is also what stops the immediate sign-out reading as
       * a bug.
       */
      message:
        'Every device will be signed out, including this one. You will need to sign in again.',
      confirmLabel: 'Log out everywhere',
      destructive: true,
      onConfirm: performLogoutAll,
    });
  };

  const Row = ({
    icon,
    title,
    description,
    onPress,
    destructive = false,
    last = false,
  }: {
    icon: string;
    title: string;
    description: string;
    onPress: () => void;
    destructive?: boolean;
    last?: boolean;
  }) => (
    <TouchableOpacity
      style={[
        styles.row,
        !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: borderColor },
      ]}
      onPress={onPress}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={description}
    >
      <Ionicons
        name={icon as any}
        size={22}
        color={destructive ? '#FF4D67' : textColor}
        style={styles.rowIcon}
      />
      <View style={styles.rowText}>
        <Text style={[styles.rowTitle, { color: destructive ? '#FF4D67' : textColor }]}>
          {title}
        </Text>
        <Text style={[styles.rowDesc, { color: subTextColor }]}>{description}</Text>
      </View>
      <ArrowIcon size={18} direction="right" color={destructive ? '#FF4D67' : subTextColor} />
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]}>
      {confirmDialog}
      <View style={[styles.header, { borderBottomColor: borderColor }]}>
        <BackButton size={24} color={textColor} style={styles.backBtn} />
        <Text style={[styles.headerTitle, { color: textColor }]}>Security</Text>
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text style={[styles.sectionTitle, { color: textColor }]}>How you sign in</Text>
        <View style={[styles.card, { backgroundColor: cardColor }]}>
          {/*
            Read-only, and deliberately not a row that navigates. Which provider
            holds your credentials is the single most useful fact on this screen —
            it decides whether a password exists to change, and it is the first
            thing support asks — but there is nothing here for the user to change.
          */}
          <View style={styles.row}>
            <Ionicons
              name="shield-checkmark-outline"
              size={22}
              color={textColor}
              style={styles.rowIcon}
            />
            <View style={styles.rowText}>
              <Text style={[styles.rowTitle, { color: textColor }]}>Sign-in method</Text>
              <Text style={[styles.rowDesc, { color: subTextColor }]}>{signInMethods}</Text>
            </View>
          </View>
        </View>

        <Text style={[styles.sectionTitle, { color: textColor }]}>Password</Text>
        {canChangePassword ? (
          <View style={[styles.card, { backgroundColor: cardColor }]}>
            <Row
              icon="lock-closed-outline"
              title="Change password"
              description="You will be asked for your current password first"
              onPress={() => router.push('/setting/change-password')}
              last
            />
          </View>
        ) : (
          // An explanation in place of the row, not an absent row. See the header
          // comment: on this screen silence reads as "unprotected".
          <View style={[styles.card, styles.explainCard, { backgroundColor: cardColor }]}>
            <Text style={[styles.explainText, { color: subTextColor }]}>
              {describePasswordlessAccount(user)}
            </Text>
          </View>
        )}

        <Text style={[styles.sectionTitle, { color: textColor }]}>Recovery details</Text>
        <View style={[styles.card, { backgroundColor: cardColor }]}>
          <Row
            icon="mail-outline"
            title="Email & phone"
            description="Kept verified so you can always get back in, and so payouts reach you"
            onPress={() => router.push('/profile/manage/edit')}
            last
          />
        </View>

        {/*
          Its own section, above "This device", because the distinction between the two
          is the entire point and a user skimming for the panic button should not have to
          read a description to find it. This is what to press when you think someone
          else is signed in.
        */}
        <Text style={[styles.sectionTitle, { color: textColor }]}>All devices</Text>
        <View style={[styles.card, { backgroundColor: cardColor }]}>
          <Row
            icon="phone-portrait-outline"
            title="Log out of all devices"
            description="Ends every session, everywhere — use this if you think someone else is signed in"
            onPress={handleLogoutAll}
            last
          />
        </View>

        <Text style={[styles.sectionTitle, { color: textColor }]}>This device</Text>
        <View style={[styles.card, { backgroundColor: cardColor }]}>
          <Row
            icon="log-out-outline"
            title="Log out"
            description="Signs out of TopHunt on this device only"
            onPress={handleLogout}
          />
          <Row
            icon="trash-outline"
            title="Delete account"
            description="Permanently deletes your account and personal data"
            onPress={() => router.push('/setting/delete-account')}
            destructive
            last
          />
        </View>

        {/*
          Worth the space: coin balances make these accounts worth stealing, and
          OTP phishing is the way it is actually attempted. The Community
          Guidelines make the same promise, so this repeats it where someone
          checking on their account security will read it.
        */}
        <View style={[styles.tip, { borderColor }]}>
          <Ionicons name="information-circle-outline" size={18} color={subTextColor} />
          <Text style={[styles.tipText, { color: subTextColor }]}>
            Nobody from TopHunt will ever ask you for your password or a one-time code.
            Anyone who does is trying to take your account — report them.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: { padding: 4, marginRight: 4 },
  headerTitle: { fontSize: 20, fontFamily: 'Urbanist-Bold' },
  content: { padding: 16, paddingBottom: 40 },
  sectionTitle: { fontSize: 15, fontFamily: 'Urbanist-Bold', marginTop: 24, marginBottom: 10 },
  card: { borderRadius: 14, overflow: 'hidden' },
  explainCard: { paddingHorizontal: 14, paddingVertical: 14 },
  explainText: { fontSize: 13, fontFamily: 'Urbanist-Regular', lineHeight: 19 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 14, gap: 12 },
  rowIcon: { width: 24, textAlign: 'center' },
  rowText: { flex: 1 },
  rowTitle: { fontSize: 15, fontFamily: 'Urbanist-SemiBold' },
  rowDesc: { fontSize: 12, fontFamily: 'Urbanist-Regular', marginTop: 2, lineHeight: 17 },
  tip: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginTop: 28,
    paddingTop: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  tipText: { flex: 1, fontSize: 12, fontFamily: 'Urbanist-Regular', lineHeight: 17 },
});
