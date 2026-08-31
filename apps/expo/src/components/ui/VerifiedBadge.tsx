import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Ionicons } from '@/src/lib/icons';

/**
 * The blue check for an admin-verified account.
 *
 * An admin could mark a user verified from the panel — the flag was written to
 * `users.verified` and the PANEL rendered a tick — but the app never read it, so
 * the one place the badge is actually for showed nothing. This is the shared
 * renderer, so every surface (profile, lists, leaderboard) shows the same mark
 * rather than each one inventing its own.
 *
 * `verified` is deliberately the only input. It is set exclusively by
 * `PATCH /admin/users/:id/profile`; it is NOT the email/phone `emailVerified`
 * flag, which is a different fact about contactability and must never be
 * conflated with an editorial blue check.
 */
export function VerifiedBadge({
  verified,
  size = 16,
  style,
}: {
  verified?: boolean | null;
  size?: number;
  style?: any;
}) {
  if (!verified) return null;
  return (
    <View
      style={[styles.wrap, style]}
      accessible
      accessibilityRole="image"
      accessibilityLabel="Verified account"
    >
      <Ionicons name="checkmark-circle" size={size} color="#1D9BF0" />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginLeft: 4, justifyContent: 'center' },
});

export default VerifiedBadge;
