import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@/src/lib/icons';
import type { FollowState } from '@/src/lib/followState';

/**
 * "This account is private" — shown in place of the battles grid, highlights
 * and tabs when the Worker answers a profile with `locked: true` (a private
 * account the viewer does not follow). The server already returns empty lists
 * for every locked sub-resource; this is what tells the viewer why.
 */
export const PrivateAccountNotice: React.FC<{
  isDark: boolean;
  followState: FollowState;
  isGuest: boolean;
}> = ({ isDark, followState, isGuest }) => {
  const textColor = isDark ? '#FFFFFF' : '#212121';
  const secondary = isDark ? '#A0A0A0' : '#666';
  const body =
    followState === 'requested'
      ? 'Your follow request is pending. Their battles will appear here once they accept it.'
      : isGuest
        ? 'Sign in and follow this account to see their battles, wins and followers.'
        : 'Follow this account to see their battles, wins and followers.';
  return (
    <View style={styles.container} accessibilityRole="summary">
      <View style={[styles.icon, { borderColor: isDark ? '#35383F' : '#DDD' }]}>
        <Ionicons name="lock-closed-outline" size={30} color={textColor} />
      </View>
      <Text style={[styles.title, { color: textColor }]}>This account is private</Text>
      <Text style={[styles.body, { color: secondary }]}>{body}</Text>
    </View>
  );
};

const styles = StyleSheet.create({
  container: { alignItems: 'center', paddingHorizontal: 32, paddingTop: 36, paddingBottom: 24 },
  icon: { width: 70, height: 70, borderRadius: 35, borderWidth: 2, justifyContent: 'center', alignItems: 'center' },
  title: { fontFamily: 'Urbanist-Bold', fontSize: 18, marginTop: 16, textAlign: 'center' },
  body: { fontFamily: 'Urbanist-Regular', fontSize: 14, textAlign: 'center', marginTop: 8, lineHeight: 20 },
});

export default PrivateAccountNotice;
