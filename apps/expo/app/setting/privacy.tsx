import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { BackButton } from '@/src/components/ui/BackButton';
import { ArrowIcon } from '@/src/components/ui/ArrowIcon';
import { Ionicons } from '@/src/lib/icons';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/src/hooks/useAuth';
import { useProfile } from '@/src/hooks/useProfileData';
import { useAppConfig } from '@/src/services/appSettings';
import { callApi } from '@/src/services/api';
import { emitToast } from '@/src/lib/toastBridge';
import { reportError } from '@/src/lib/reportError';
import { setUsageEnabled, useUsageEnabled } from '@/src/services/usageStats';

/**
 * Privacy.
 *
 * ## Why this screen exists
 *
 * "Privacy Settings" on Manage Profile pushed `/setting`, and so did "Security"
 * one row below it. Two rows with different labels and different icons led to the
 * same generic settings list, which contained no privacy section — so the promise
 * each row made was not kept, and a user looking for the private-account switch
 * had nowhere to find it.
 *
 * The switch itself was the odd part: `users.is_private` has existed in the schema
 * from the first migration, `updateProfile` accepts it, and the profile screen
 * already reads it to lock the tabs on a private profile. The column was wired end
 * to end with no way for a user to set it.
 *
 * ## What belongs here
 *
 * Controls over **who can see you**. Controls over **who can get into your
 * account** are Security, next door. Blocking is reachable from both because it is
 * genuinely both, but it is owned by `/setting/blocked`.
 *
 * Data rights (export, deletion) are here rather than under Security because they
 * are about the data itself, and because the privacy policy points at this screen.
 */
export default function PrivacySettingsScreen() {
  const router = useRouter();
  const isDark = useColorScheme() === 'dark';
  const textColor = isDark ? '#fff' : '#212121';
  const subTextColor = isDark ? '#9E9E9E' : '#616161';
  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;
  const cardColor = isDark ? '#1F222A' : '#F7F7F9';
  const borderColor = isDark ? '#35383F' : '#EEEEEE';

  const { user } = useAuth();
  const usageEnabled = useUsageEnabled();
  const { config } = useAppConfig();
  const queryClient = useQueryClient();
  const { data: profile, isLoading } = useProfile(user?.uid || '');

  const supportEmail = ((config as any)?.supportEmail || '').trim();

  /**
   * Local mirror of the server value.
   *
   * The switch is driven from state rather than straight off the query so it can
   * respond on the same frame as the tap. `useProfile` polls, and a switch that
   * waits for a round-trip before moving reads as broken.
   */
  const [isPrivate, setIsPrivate] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    // Adopt the server value only while no edit is in flight, otherwise a poll
    // landing mid-save would flick the switch back to its old position.
    if (profile && !saving) setIsPrivate(!!(profile as any).isPrivate);
  }, [profile, saving]);

  const togglePrivate = async (next: boolean) => {
    if (!user) return;
    const previous = isPrivate;
    setIsPrivate(next);
    setSaving(true);
    try {
      const res: any = await callApi('updateProfile', { isPrivate: next });
      const approved = Number(res?.approvedRequests || 0);
      // Keep every other screen reading the same value — the profile header shows
      // a private badge and the tab strip disables itself from this field.
      queryClient.setQueryData(['profile', user.uid], (old: any) =>
        old ? { ...old, isPrivate: next } : old,
      );
      void queryClient.invalidateQueries({ queryKey: ['profile', user.uid] });
      // Going public approves every pending follow request (as on Instagram).
      if (approved > 0) {
        void queryClient.invalidateQueries({ queryKey: ['followRequests'] });
        void queryClient.invalidateQueries({ queryKey: ['followRequestCount'] });
      }
      emitToast(
        next
          ? 'Your account is now private. New followers will need your approval.'
          : approved > 0
            ? `Your account is now public. ${approved} pending request${approved === 1 ? ' was' : 's were'} approved.`
            : 'Your account is now public.',
        'success',
      );
    } catch (e: any) {
      setIsPrivate(previous);
      reportError(e, { screen: 'privacy-settings', action: 'toggle-private' });
      emitToast(e?.message || 'Could not save that change. Please try again.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const requestDataCopy = () => {
    const subject = encodeURIComponent('Request for a copy of my data');
    const body = encodeURIComponent(
      `Please send me a copy of the personal data held for my account.\n\nAccount: ${
        (profile as any)?.username ? `@${(profile as any).username}` : user?.email || ''
      }\n`,
    );
    void Linking.openURL(`mailto:${supportEmail}?subject=${subject}&body=${body}`).catch(() => {
      emitToast(`No mail app found. Write to ${supportEmail}.`, 'info');
    });
  };

  const renderHeader = () => (
    <View style={[styles.header, { borderBottomColor: borderColor }]}>
      <BackButton size={24} color={textColor} style={styles.backBtn} />
      <Text style={[styles.headerTitle, { color: textColor }]}>Privacy</Text>
    </View>
  );

  const Row = ({
    icon,
    title,
    description,
    onPress,
    last = false,
  }: {
    icon: string;
    title: string;
    description: string;
    onPress: () => void;
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
      <Ionicons name={icon as any} size={22} color={textColor} style={styles.rowIcon} />
      <View style={styles.rowText}>
        <Text style={[styles.rowTitle, { color: textColor }]}>{title}</Text>
        <Text style={[styles.rowDesc, { color: subTextColor }]}>{description}</Text>
      </View>
      <ArrowIcon size={18} direction="right" color={subTextColor} />
    </TouchableOpacity>
  );

  // Device-level, so it is offered signed in or not (src/services/usageStats.ts).
  const usageCard = (
    <View style={[styles.card, { backgroundColor: cardColor }]}>
      <View style={styles.row}>
        <Ionicons name="trending-up" size={22} color={textColor} style={styles.rowIcon} />
        <View style={styles.rowText}>
          <Text style={[styles.rowTitle, { color: textColor }]}>Share anonymous usage statistics</Text>
          <Text style={[styles.rowDesc, { color: subTextColor }]}>
            Counts such as how many stories finish and how often videos buffer, with no
            account, device or content identifiers. Helps us find what is slow or broken.
          </Text>
        </View>
        <Switch
          value={usageEnabled}
          onValueChange={(v) => void setUsageEnabled(v)}
          trackColor={{ false: '#767577', true: '#FF4D67' }}
          thumbColor="#FFFFFF"
          accessibilityLabel="Share anonymous usage statistics"
        />
      </View>
    </View>
  );

  // Not signed in: the private-account switch has nothing to act on. Say so
  // rather than rendering a switch that would fail on its first tap.
  if (!user) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor }]}>
        {renderHeader()}
        <View style={styles.center}>
          <Text style={[styles.emptyText, { color: subTextColor }]}>
            Sign in to manage your privacy settings.
          </Text>
          <TouchableOpacity
            style={styles.primaryButton}
            onPress={() => router.push('/auth/login')}
            accessibilityRole="button"
          >
            <Text style={styles.primaryButtonText}>Sign in</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.content}>{usageCard}</View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]}>
      {renderHeader()}
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text style={[styles.sectionTitle, { color: textColor }]}>Who can see you</Text>

        <View style={[styles.card, { backgroundColor: cardColor }]}>
          <View style={styles.row}>
            <Ionicons name="lock-closed-outline" size={22} color={textColor} style={styles.rowIcon} />
            <View style={styles.rowText}>
              <Text style={[styles.rowTitle, { color: textColor }]}>Private account</Text>
              <Text style={[styles.rowDesc, { color: subTextColor }]}>
                New followers need your approval. Only approved followers see your
                profile&apos;s battles, wins, followers and stories. Battles you enter still
                appear in the public feed, because the other player and voters share them.
              </Text>
            </View>
            {isLoading && isPrivate === null ? (
              <ActivityIndicator size="small" color="#FF4D67" />
            ) : (
              <Switch
                value={!!isPrivate}
                disabled={saving || isPrivate === null}
                onValueChange={togglePrivate}
                trackColor={{ false: '#767577', true: '#FF4D67' }}
                thumbColor="#FFFFFF"
                accessibilityLabel="Private account"
              />
            )}
          </View>
        </View>

        {/*
          Stated up front, because it is the one thing about this switch that
          surprises people. A contest already under way is decided by votes on both
          entries, so hiding one retrospectively would change the other entrant's
          result — the server cannot honour it and we should not imply that it can.
        */}
        <Text style={[styles.note, { color: subTextColor }]}>
          Going private does not hide a contest you have already entered. Live results
          depend on both entries staying visible until the contest closes.
        </Text>

        <Text style={[styles.sectionTitle, { color: textColor }]}>People</Text>
        <View style={[styles.card, { backgroundColor: cardColor }]}>
          <Row
            icon="ban-outline"
            title="Blocked & Muted"
            description="Review and undo accounts you have blocked or muted"
            onPress={() => router.push('/setting/blocked')}
            last
          />
        </View>

        <Text style={[styles.sectionTitle, { color: textColor }]}>Your data</Text>
        <View style={[styles.card, { backgroundColor: cardColor }]}>
          <Row
            icon="document-text-outline"
            title="Privacy Policy"
            description="What we collect, why, and how long we keep it"
            onPress={() => router.push('/legal/privacy')}
          />
          {/*
            Only when an address is configured — otherwise this would open a mail
            composer with no recipient, which is the dead-affordance problem the
            Settings screen documents at length.
          */}
          {!!supportEmail && (
            <Row
              icon="mail-outline"
              title="Request a copy of your data"
              description={`We reply within 30 days at ${supportEmail}`}
              onPress={requestDataCopy}
            />
          )}
          <Row
            icon="trash-outline"
            title="Delete account"
            description="Permanently delete your account and personal data"
            onPress={() => router.push('/setting/delete-account')}
            last
          />
        </View>
        {usageCard}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
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
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 14, gap: 12 },
  rowIcon: { width: 24, textAlign: 'center' },
  rowText: { flex: 1 },
  rowTitle: { fontSize: 15, fontFamily: 'Urbanist-SemiBold' },
  rowDesc: { fontSize: 12, fontFamily: 'Urbanist-Regular', marginTop: 2, lineHeight: 17 },
  note: { fontSize: 12, fontFamily: 'Urbanist-Regular', marginTop: 10, lineHeight: 17 },
  emptyText: { fontSize: 15, fontFamily: 'Urbanist-Regular', textAlign: 'center' },
  primaryButton: {
    marginTop: 20,
    backgroundColor: '#FF4D67',
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderRadius: 24,
  },
  primaryButtonText: { color: '#fff', fontSize: 15, fontFamily: 'Urbanist-Bold' },
});
