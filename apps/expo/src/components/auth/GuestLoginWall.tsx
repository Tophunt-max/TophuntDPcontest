import React from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet, TouchableWithoutFeedback } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@/src/lib/icons';
import { loginHref, signupHref } from '@/src/lib/authGate';
import { webPhoneColumn } from '@/src/lib/layout';

/**
 * The soft login wall (see src/lib/guestWall.ts for when it shows). A bottom
 * sheet with Log in / Sign up / Not now. Dismissible on purpose: it nudges, it
 * never locks the feed.
 */
export const GuestLoginWall: React.FC<{
  visible: boolean;
  isDark: boolean;
  onDismiss: () => void;
  /** Where sign-in returns to. */
  returnTo?: string;
}> = ({ visible, isDark, onDismiss, returnTo = '/home' }) => {
  const router = useRouter();
  const text = isDark ? '#FFFFFF' : '#212121';
  const sub = isDark ? '#A0A0A0' : '#666';
  const go = (href: string) => {
    onDismiss();
    router.push(href as any);
  };
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onDismiss}>
      <View style={styles.root}>
        <TouchableWithoutFeedback onPress={onDismiss} accessibilityLabel="Close">
          <View style={styles.overlay} />
        </TouchableWithoutFeedback>
        <View style={[styles.sheet, { backgroundColor: isDark ? '#181A20' : '#FFFFFF' }]} accessibilityViewIsModal>
          <View style={styles.iconWrap}>
            <Ionicons name="flame" size={30} color="#FF4D67" />
          </View>
          <Text style={[styles.title, { color: text }]}>See more battles on TopHunt</Text>
          <Text style={[styles.body, { color: sub }]}>
            Sign in to vote for your favourite, follow creators and enter contests yourself.
          </Text>
          <TouchableOpacity
            style={[styles.button, styles.primary]}
            onPress={() => go(loginHref(returnTo))}
            accessibilityRole="button"
            accessibilityLabel="Log in"
          >
            <Text style={styles.primaryText}>Log in</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.button, styles.secondary, { borderColor: isDark ? '#35383F' : '#FF4D67' }]}
            onPress={() => go(signupHref(returnTo))}
            accessibilityRole="button"
            accessibilityLabel="Sign up"
          >
            <Text style={[styles.secondaryText, { color: isDark ? '#FFF' : '#FF4D67' }]}>Sign up</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onDismiss} style={styles.notNow} accessibilityRole="button" accessibilityLabel="Not now">
            <Text style={[styles.notNowText, { color: sub }]}>Not now</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: {
    ...webPhoneColumn,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 24,
    paddingTop: 24,
    paddingBottom: 32,
    alignItems: 'center',
  },
  iconWrap: { width: 60, height: 60, borderRadius: 30, backgroundColor: '#FFE8EC', justifyContent: 'center', alignItems: 'center' },
  title: { fontFamily: 'Urbanist-Bold', fontSize: 20, marginTop: 14, textAlign: 'center' },
  body: { fontFamily: 'Urbanist-Regular', fontSize: 14, marginTop: 8, textAlign: 'center', lineHeight: 20 },
  button: { width: '100%', minHeight: 48, borderRadius: 24, justifyContent: 'center', alignItems: 'center', marginTop: 12 },
  primary: { backgroundColor: '#FF4D67', marginTop: 20 },
  primaryText: { color: '#FFF', fontFamily: 'Urbanist-Bold', fontSize: 16 },
  secondary: { borderWidth: 1 },
  secondaryText: { fontFamily: 'Urbanist-Bold', fontSize: 16 },
  notNow: { marginTop: 14, minHeight: 36, justifyContent: 'center', paddingHorizontal: 16 },
  notNowText: { fontFamily: 'Urbanist-SemiBold', fontSize: 14 },
});

export default GuestLoginWall;
