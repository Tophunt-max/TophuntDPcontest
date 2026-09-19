import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal, Image, ScrollView, Linking } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useThemeColor } from '@/hooks/use-theme-color';
import { useAuth } from '@/src/hooks/useAuth';
import { readApi, callApi } from '@/src/services/api';
import { CloseIcon } from '@/src/components/ui/CloseIcon';
import { loadSnoozes, snoozeAnnouncement } from '@/src/lib/announcementSnooze';

const BRAND_PRIMARY = '#7C3AED';

interface Announcement {
  id: string;
  title: string;
  body: string;
  link?: string | null;
  image?: string | null;
  snoozeHours?: number | null;
}

/**
 * Admin-controlled announcement POPUP.
 *
 * Shows the single best announcement the Worker deems eligible for the signed-in
 * user (/read/announcements/active — already filtered by targeting, schedule and
 * server-side snooze). Closing with × calls `dismissAnnouncement`, which snoozes
 * it server-side for `snoozeHours` (default 24); after that window it re-appears
 * on its own. A local AsyncStorage snooze hides it instantly so a refetch racing
 * the dismiss write can't flash it back.
 *
 * Only fetches while authenticated — /read/announcements/active requires auth,
 * and an unauthenticated call would trip the api client's 401 session-end path.
 *
 * Mounted globally in app/_layout.tsx alongside <AnnouncementBanner/>.
 */
export function AnnouncementPopup() {
  const { user } = useAuth();
  const [snoozes, setSnoozes] = useState<Record<string, number>>({});
  const [snoozesReady, setSnoozesReady] = useState(false);
  // The announcement the user just closed — hidden immediately, before refetch.
  const [justDismissed, setJustDismissed] = useState<string | null>(null);

  // Hydrate the local snooze cache once.
  useEffect(() => {
    let alive = true;
    loadSnoozes().then((s) => {
      if (alive) {
        setSnoozes(s);
        setSnoozesReady(true);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  const { data, refetch } = useQuery<Announcement | null>({
    queryKey: ['active-announcement'],
    queryFn: () => readApi('/read/announcements/active'),
    enabled: !!user,
    // Popups change rarely and this is a per-user query — poll gently.
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
    refetchOnMount: true,
  });

  const cardBg = useThemeColor({ light: '#FFFFFF', dark: '#1F222A' }, 'background');
  const textColor = useThemeColor({}, 'text');
  const subTextColor = useThemeColor({ light: '#4B5563', dark: '#C7C9D1' }, 'text');

  const announcement = data ?? null;

  // Locally snoozed (or just dismissed) announcements must not render, even if a
  // stale query result still carries them.
  const visible = useMemo(() => {
    if (!snoozesReady || !announcement) return false;
    if (justDismissed === announcement.id) return false;
    const until = snoozes[announcement.id];
    if (until && until > Date.now()) return false;
    return true;
  }, [snoozesReady, announcement, snoozes, justDismissed]);

  const dismiss = useCallback(async () => {
    if (!announcement) return;
    const id = announcement.id;
    const hours = announcement.snoozeHours && announcement.snoozeHours > 0 ? announcement.snoozeHours : 24;
    const until = Date.now() + hours * 3600_000;
    // Hide instantly + remember locally so a racing refetch can't reopen it.
    setJustDismissed(id);
    setSnoozes((prev) => ({ ...prev, [id]: until }));
    void snoozeAnnouncement(id, until);
    try {
      await callApi('dismissAnnouncement', { announcementId: id });
    } catch {
      /* server snooze failed; local snooze still hides it until next app run */
    }
    // Pull the next eligible announcement (if any).
    void refetch();
  }, [announcement, refetch]);

  const openLink = useCallback(() => {
    if (announcement?.link) Linking.openURL(announcement.link).catch(() => {});
  }, [announcement]);

  if (!visible || !announcement) return null;

  return (
    <Modal animationType="fade" transparent visible onRequestClose={dismiss}>
      <View style={styles.centeredView}>
        <View style={[styles.modalView, { backgroundColor: cardBg }]}>
          <TouchableOpacity
            onPress={dismiss}
            style={styles.closeButton}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityRole="button"
            accessibilityLabel="Dismiss announcement"
          >
            <CloseIcon size={22} color={textColor} variant="circle" />
          </TouchableOpacity>

          {announcement.image ? (
            <Image source={{ uri: announcement.image }} style={styles.image} resizeMode="cover" />
          ) : null}

          <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
            <Text style={[styles.title, { color: textColor }]}>{announcement.title}</Text>
            <Text style={[styles.body, { color: subTextColor }]}>{announcement.body}</Text>
          </ScrollView>

          <View style={styles.actions}>
            {announcement.link ? (
              <TouchableOpacity style={styles.primaryBtn} onPress={openLink} accessibilityRole="button">
                <Text style={styles.primaryBtnText}>Learn more</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity
              style={[styles.secondaryBtn, !announcement.link && styles.secondaryBtnSolo]}
              onPress={dismiss}
              accessibilityRole="button"
            >
              <Text style={[styles.secondaryBtnText, { color: announcement.link ? subTextColor : '#FFFFFF' }, !announcement.link && styles.secondaryBtnSoloText]}>
                {announcement.link ? 'Dismiss' : 'Got it'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  centeredView: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingHorizontal: 24,
  },
  modalView: {
    width: '100%',
    maxWidth: 420,
    borderRadius: 20,
    padding: 22,
    maxHeight: '80%',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 6,
  },
  closeButton: {
    position: 'absolute',
    right: 12,
    top: 12,
    zIndex: 2,
    padding: 4,
  },
  image: {
    width: '100%',
    height: 150,
    borderRadius: 14,
    marginBottom: 16,
    marginTop: 8,
  },
  scroll: {
    marginTop: 8,
  },
  scrollContent: {
    paddingRight: 4,
  },
  title: {
    fontSize: 19,
    fontFamily: 'Urbanist-Bold',
    marginBottom: 10,
    paddingRight: 28,
  },
  body: {
    fontSize: 14,
    fontFamily: 'Urbanist-Regular',
    lineHeight: 21,
  },
  actions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 20,
  },
  primaryBtn: {
    flex: 1,
    backgroundColor: BRAND_PRIMARY,
    borderRadius: 14,
    paddingVertical: 12,
    alignItems: 'center',
  },
  primaryBtnText: {
    color: '#FFFFFF',
    fontFamily: 'Urbanist-Bold',
    fontSize: 15,
  },
  secondaryBtn: {
    flex: 1,
    borderRadius: 14,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryBtnSolo: {
    backgroundColor: BRAND_PRIMARY,
  },
  secondaryBtnText: {
    fontFamily: 'Urbanist-SemiBold',
    fontSize: 15,
  },
  secondaryBtnSoloText: {
    fontFamily: 'Urbanist-Bold',
  },
});
