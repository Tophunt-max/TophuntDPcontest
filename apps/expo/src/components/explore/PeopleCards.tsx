import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { Ionicons, MaterialCommunityIcons } from '@/src/lib/icons';
import { Avatar } from '@/src/components/ui/Avatar';
import { VerifiedBadge } from '@/src/components/ui/VerifiedBadge';
import { followButtonLabel, type FollowState } from '@/src/lib/followState';
import { compactCount } from '@/src/lib/exploreMedia';
import type { SuggestedPerson } from '@/src/services/explore';
import { ScaleTouchable } from './ScaleTouchable';
import { BRAND, GOLD, type ExplorePalette } from './theme';

/** Suggested person with a follow button. Profiles are public: tapping never asks to sign in. */
export const PersonCard = React.memo(function PersonCard({
  person,
  width,
  palette,
  followState,
  onFollow,
}: {
  person: SuggestedPerson;
  width: number;
  palette: ExplorePalette;
  followState: FollowState;
  onFollow: (id: string) => void;
}) {
  const router = useRouter();
  const active = followState !== 'none';
  return (
    <View style={[styles.person, { width, backgroundColor: palette.card, borderColor: palette.border }]}>
      <TouchableOpacity
        activeOpacity={0.85}
        onPress={() => router.push(`/profile?userId=${encodeURIComponent(person.id)}` as any)}
        style={{ alignItems: 'center', width: '100%' }}
        accessibilityRole="link"
        accessibilityLabel={`${person.name}, @${person.username}. Open profile`}
      >
        <LinearGradient colors={['#FF4D67', '#8B5CF6']} style={styles.ring}>
          <View style={[styles.ringInner, { backgroundColor: palette.card }]}>
            <Avatar uri={person.avatar} name={person.name} size={62} />
          </View>
        </LinearGradient>
        <View style={styles.nameRow}>
          <Text style={[styles.name, { color: palette.text }]} numberOfLines={1}>{person.name}</Text>
          <VerifiedBadge verified={person.verified} size={13} />
        </View>
        <Text style={[styles.handle, { color: palette.sub }]} numberOfLines={1}>@{person.username}</Text>
        {person.followersCount > 0 ? (
          <Text style={[styles.followers, { color: palette.sub }]}>{compactCount(person.followersCount)} followers</Text>
        ) : null}
      </TouchableOpacity>
      <TouchableOpacity
        activeOpacity={0.85}
        onPress={() => onFollow(person.id)}
        style={[styles.follow, active ? { backgroundColor: palette.chip } : { backgroundColor: BRAND }]}
        accessibilityRole="button"
        accessibilityState={{ selected: active }}
        accessibilityLabel={`${followButtonLabel(followState)} ${person.username}`}
      >
        {!active && <Ionicons name="add" size={14} color="#FFF" />}
        <Text style={[styles.followText, { color: active ? palette.text : '#FFF' }]}>{followButtonLabel(followState)}</Text>
      </TouchableOpacity>
    </View>
  );
});

/** Top creators rail item: avatar with a rank medal and win count. */
export const CreatorChip = React.memo(function CreatorChip({ user, rank, palette }: { user: any; rank: number; palette: ExplorePalette }) {
  const router = useRouter();
  const medal = rank === 1 ? '#FFD54A' : rank === 2 ? '#CBD5E1' : rank === 3 ? '#F4A261' : palette.chip;
  return (
    <ScaleTouchable
      style={styles.creator}
      onPress={() => router.push(`/profile?userId=${encodeURIComponent(user.uid)}` as any)}
      accessibilityRole="link"
      accessibilityLabel={`Rank ${rank}, ${user.username || user.fullName}, ${user.wins || 0} wins`}
    >
      <View style={{ alignItems: 'center' }}>
        <View style={[styles.creatorRing, { borderColor: rank <= 3 ? medal : palette.border }]}>
          <Avatar uri={user.profileImageUrlThumb || user.profileImageUrl} name={user.fullName || user.username} size={60} />
        </View>
        <View style={[styles.rank, { backgroundColor: medal }]}>
          <Text style={[styles.rankText, { color: rank <= 3 ? '#3B2A00' : palette.text }]}>{rank}</Text>
        </View>
        <Text style={[styles.creatorName, { color: palette.text }]} numberOfLines={1}>{user.username || user.fullName || 'user'}</Text>
        <View style={styles.wins}>
          <MaterialCommunityIcons name="trophy" size={11} color={GOLD} />
          <Text style={[styles.winsText, { color: palette.sub }]}>{compactCount(user.wins)} wins</Text>
        </View>
      </View>
    </ScaleTouchable>
  );
});

const styles = StyleSheet.create({
  person: { borderRadius: 20, borderWidth: 1, padding: 14, alignItems: 'center' },
  ring: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center' },
  ringInner: { width: 68, height: 68, borderRadius: 34, alignItems: 'center', justifyContent: 'center' },
  nameRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 3, marginTop: 10, maxWidth: '100%' },
  name: { fontSize: 14, fontFamily: 'Urbanist-Bold', flexShrink: 1 },
  handle: { fontSize: 12, fontFamily: 'Urbanist-Medium', marginTop: 1 },
  followers: { fontSize: 11, fontFamily: 'Urbanist-SemiBold', marginTop: 3 },
  follow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 3, paddingVertical: 8, borderRadius: 100, marginTop: 12, width: '100%' },
  followText: { fontSize: 13, fontFamily: 'Urbanist-Bold' },
  creator: { width: 78 },
  creatorRing: { padding: 2, borderRadius: 34, borderWidth: 2.5 },
  rank: { position: 'absolute', top: 50, minWidth: 22, height: 22, borderRadius: 11, paddingHorizontal: 5, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#FFF' },
  rankText: { fontSize: 11, fontFamily: 'Urbanist-Black' },
  creatorName: { fontSize: 12, fontFamily: 'Urbanist-Bold', marginTop: 12, maxWidth: 78 },
  wins: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 1 },
  winsText: { fontSize: 10, fontFamily: 'Urbanist-SemiBold' },
});
