import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  RefreshControl,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useQueryClient } from '@tanstack/react-query';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { BackButton } from '@/src/components/ui/BackButton';
import { Ionicons } from '@/src/lib/icons';
import { Colors } from '@/constants/theme';
import { emitToast } from '@/src/lib/toastBridge';
import { appShareOrigin, isCompletedShare, shareBattleLink, whatsappShareUrl, openShareUrl } from '@/src/lib/share';
import { referralCaption } from '@/src/lib/shareCaptions';
import {
  QUALIFY_COPY,
  REFERRALS_QUERY_KEY,
  applyReferralCode,
  clearPendingInvite,
  getPendingInvite,
  normalizeReferralCode,
  useMyReferrals,
  type ReferralStatus,
} from '@/src/services/referrals';

const BRAND = '#FF4D67';

const STATUS: Record<ReferralStatus, { label: string; color: string; bg: string }> = {
  pending: { label: 'Pending', color: '#B45309', bg: '#FEF3C7' },
  review: { label: 'In review', color: '#1D4ED8', bg: '#DBEAFE' },
  rewarded: { label: 'Rewarded', color: '#15803D', bg: '#DCFCE7' },
  rejected: { label: 'Not eligible', color: '#B91C1C', bg: '#FEE2E2' },
  expired: { label: 'Expired', color: '#475569', bg: '#E2E8F0' },
};

/**
 * Refer & Earn — the user's code and invite link, how the reward works, their
 * invited friends, milestone progress, and (for a new account) a box to apply a
 * friend's code. Server: GET /read/me/referrals.
 */
export default function ReferralScreen() {
  const isDark = useColorScheme() === 'dark';
  const text = isDark ? '#fff' : '#212121';
  const sub = isDark ? '#A0A0A0' : '#666';
  const card = isDark ? '#1F222A' : '#FFFFFF';
  const border = isDark ? '#35383F' : '#EEEEEE';
  const bg = isDark ? Colors.dark.background : Colors.light.background;

  const qc = useQueryClient();
  const { data, isLoading, refetch, isRefetching, error } = useMyReferrals();
  const [applyCode, setApplyCode] = useState('');
  const [applying, setApplying] = useState(false);

  // A code from an invite link opened before sign-up / on this device.
  useEffect(() => {
    getPendingInvite().then((c) => c && setApplyCode((cur) => cur || c));
  }, []);

  const program = data?.program;
  const link = useMemo(() => {
    if (!data?.code) return null;
    const origin = appShareOrigin();
    return origin ? `${origin.replace(/\/$/, '')}/invite/${encodeURIComponent(data.code)}` : data.link;
  }, [data?.code, data?.link]);

  const caption = data?.code ? referralCaption(data.code, link) : '';

  const copy = async (value: string, what: string) => {
    try {
      await Clipboard.setStringAsync(value);
      Haptics.selectionAsync().catch(() => {});
      emitToast(`${what} copied`, 'success');
    } catch {
      emitToast('Copy nahi ho paya', 'error');
    }
  };

  const share = async () => {
    if (!data?.code || !link) return;
    Haptics.selectionAsync().catch(() => {});
    const outcome = await shareBattleLink({ caption, url: link });
    if (outcome === 'copied_link') emitToast('Invite link copied — ab dosto ko bhejo!', 'success');
    else if (outcome === 'failed') emitToast('Share nahi ho paya. Link copy karke bhejo.', 'error');
    else if (!isCompletedShare(outcome) && outcome !== 'dismissed') emitToast('Link copy karke share karo.', 'info');
  };

  const shareWhatsApp = () => {
    if (!caption) return;
    openShareUrl(whatsappShareUrl(caption));
  };

  const onApply = async () => {
    const code = normalizeReferralCode(applyCode);
    if (code.length < 4) {
      emitToast('Sahi referral code daalo', 'error');
      return;
    }
    setApplying(true);
    try {
      const res: any = await applyReferralCode(code);
      if (res?.status === 'applied') {
        emitToast(
          res.referralStatus === 'rewarded'
            ? 'Referral reward mil gaya! 🎉'
            : `Code lag gaya! ${QUALIFY_COPY[res.qualifyAction as keyof typeof QUALIFY_COPY]?.short ?? 'qualify'} karte hi reward milega.`,
          'success',
        );
      } else if (res?.status === 'already_referred') {
        emitToast('Aap pehle se kisi ke referral se jude ho.', 'info');
      }
      await clearPendingInvite();
      qc.invalidateQueries({ queryKey: REFERRALS_QUERY_KEY });
    } catch (e: any) {
      emitToast(e?.message || 'Code apply nahi ho paya', 'error');
    } finally {
      setApplying(false);
    }
  };

  const nextMilestone = useMemo(() => {
    if (!program?.milestones?.length || !data) return null;
    return program.milestones.find((m) => m.count > data.stats.successful) ?? null;
  }, [program, data]);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: bg }]}>
      <View style={styles.header}>
        <BackButton size={24} color={text} style={{ marginRight: 12 }} />
        <Text style={[styles.headerTitle, { color: text }]}>Refer & Earn</Text>
      </View>

      {isLoading ? (
        <ActivityIndicator color={BRAND} style={{ marginTop: 40 }} />
      ) : error || !data ? (
        <View style={styles.center}>
          <Text style={{ color: sub, fontFamily: 'Urbanist-Medium' }}>Referral details load nahi ho paye.</Text>
          <TouchableOpacity onPress={() => refetch()} style={[styles.primaryBtn, { marginTop: 16 }]}>
            <Text style={styles.primaryBtnText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: 20, paddingBottom: 48 }}
          refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={BRAND} />}
        >
          {/* Hero */}
          <View style={[styles.hero]}>
            <Ionicons name="gift" size={36} color="#fff" />
            {program?.enabled ? (
              <>
                <Text style={styles.heroTitle}>
                  Dost ko invite karo, dono ko coins! 🎉
                </Text>
                <Text style={styles.heroSub}>
                  Aapko {program.referrerReward} coins · Dost ko {program.refereeReward} coins
                </Text>
              </>
            ) : (
              <>
                <Text style={styles.heroTitle}>Referral program abhi band hai</Text>
                <Text style={styles.heroSub}>Jaldi wapas aayega. Pending referrals ka reward phir bhi milega.</Text>
              </>
            )}
          </View>

          {/* Code + link */}
          {data.code && (
            <View style={[styles.card, { backgroundColor: card, borderColor: border }]}>
              <Text style={[styles.label, { color: sub }]}>AAPKA REFERRAL CODE</Text>
              <TouchableOpacity onPress={() => copy(data.code!, 'Code')} style={[styles.codeBox, { borderColor: BRAND }]} activeOpacity={0.8}>
                <Text style={[styles.code, { color: text }]}>{data.code}</Text>
                <Ionicons name="copy-outline" size={20} color={BRAND} />
              </TouchableOpacity>
              {link && (
                <TouchableOpacity onPress={() => copy(link, 'Invite link')} activeOpacity={0.8}>
                  <Text style={[styles.link, { color: sub }]} numberOfLines={1}>
                    {link}
                  </Text>
                </TouchableOpacity>
              )}
              <View style={styles.row}>
                <TouchableOpacity onPress={share} style={[styles.primaryBtn, { flex: 1 }]} disabled={!program?.enabled}>
                  <Ionicons name="share-social-outline" size={18} color="#fff" />
                  <Text style={styles.primaryBtnText}>Invite friends</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={shareWhatsApp} style={[styles.waBtn]} disabled={!program?.enabled} accessibilityLabel="Share on WhatsApp">
                  <Ionicons name="chatbubble-ellipses-outline" size={22} color="#fff" />
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* Stats */}
          <View style={styles.statsRow}>
            {(
              [
                ['Invited', data.stats.invited],
                ['Successful', data.stats.successful],
                ['Pending', data.stats.pending],
                ['Coins earned', data.stats.earned],
              ] as const
            ).map(([k, v]) => (
              <View key={k} style={[styles.stat, { backgroundColor: card, borderColor: border }]}>
                <Text style={[styles.statValue, { color: text }]}>{Number(v || 0).toLocaleString()}</Text>
                <Text style={[styles.statLabel, { color: sub }]}>{k}</Text>
              </View>
            ))}
          </View>

          {/* How it works */}
          {program && (
            <View style={[styles.card, { backgroundColor: card, borderColor: border }]}>
              <Text style={[styles.cardTitle, { color: text }]}>Kaise kaam karta hai</Text>
              {[
                'Apna code ya invite link dost ko bhejo',
                `Dost signup par aapka code lagaye${program.applyWindowDays ? ` (join karne ke ${Math.max(1, program.applyWindowDays)} din ke andar)` : ''}`,
                program.qualifyAction === 'signup'
                  ? 'Signup hote hi dono ko coins mil jaate hain'
                  : `${QUALIFY_COPY[program.qualifyAction].step} — ${program.qualifyWindowDays} din ke andar`,
                `Aapko ${program.referrerReward} coins, dost ko ${program.refereeReward} coins — seedha wallet mein`,
              ].map((s, i) => (
                <View key={i} style={styles.step}>
                  <View style={styles.stepDot}>
                    <Text style={styles.stepNum}>{i + 1}</Text>
                  </View>
                  <Text style={[styles.stepText, { color: text }]}>{s}</Text>
                </View>
              ))}
              <Text style={[styles.fine, { color: sub }]}>
                Ek device se ek hi referral valid hai. Apna khud ka code, ya fake accounts, reward nahi dete.
              </Text>
            </View>
          )}

          {/* Milestones */}
          {!!program?.milestones?.length && (
            <View style={[styles.card, { backgroundColor: card, borderColor: border }]}>
              <Text style={[styles.cardTitle, { color: text }]}>Milestone bonus 🏆</Text>
              {program.milestones.map((m) => {
                const done = data.stats.successful >= m.count;
                const pct = Math.min(1, data.stats.successful / m.count);
                return (
                  <View key={m.count} style={{ marginTop: 12 }}>
                    <View style={styles.rowBetween}>
                      <Text style={[styles.stepText, { color: text, marginLeft: 0 }]}>
                        {m.count} successful referrals → +{m.bonus} coins
                      </Text>
                      {done ? <Ionicons name="checkmark-circle" size={18} color="#16A34A" /> : null}
                    </View>
                    <View style={[styles.bar, { backgroundColor: border }]}>
                      <View style={[styles.barFill, { width: `${pct * 100}%`, backgroundColor: done ? '#16A34A' : BRAND }]} />
                    </View>
                  </View>
                );
              })}
              {nextMilestone && (
                <Text style={[styles.fine, { color: sub }]}>
                  Agle bonus ke liye {nextMilestone.count - data.stats.successful} aur successful referral chahiye.
                </Text>
              )}
            </View>
          )}

          {/* Referred by / apply a code */}
          {data.referredBy ? (
            <View style={[styles.card, { backgroundColor: card, borderColor: border }]}>
              <Text style={[styles.cardTitle, { color: text }]}>Aapka joining reward</Text>
              <View style={[styles.rowBetween, { marginTop: 8 }]}>
                <Text style={[styles.stepText, { color: text, marginLeft: 0, flex: 1 }]}>
                  {data.referredBy.status === 'rewarded'
                    ? `${data.referredBy.reward} coins mil gaye 🎉`
                    : data.referredBy.status === 'pending' && data.referredBy.qualifyAction
                      ? data.referredBy.qualifyAction === 'signup'
                        ? 'Reward process ho raha hai'
                        : `${QUALIFY_COPY[data.referredBy.qualifyAction].short} karte hi ${program?.refereeReward ?? ''} coins milenge`
                      : data.referredBy.status === 'review'
                        ? 'Reward review mein hai — jaldi milega'
                        : 'Ye referral reward ke liye eligible nahi raha'}
                </Text>
                <StatusPill status={data.referredBy.status} />
              </View>
            </View>
          ) : data.canApply && program?.enabled ? (
            <View style={[styles.card, { backgroundColor: card, borderColor: border }]}>
              <Text style={[styles.cardTitle, { color: text }]}>Friend ka code hai?</Text>
              <Text style={[styles.fine, { color: sub, marginTop: 4 }]}>
                Code lagao aur {program.refereeReward} coins pao
                {data.applyUntil ? ` · ${new Date(data.applyUntil).toLocaleDateString()} tak` : ''}
              </Text>
              <View style={[styles.row, { marginTop: 12 }]}>
                <TextInput
                  value={applyCode}
                  onChangeText={(t) => setApplyCode(normalizeReferralCode(t))}
                  placeholder="Referral code"
                  placeholderTextColor="#9E9E9E"
                  autoCapitalize="characters"
                  style={[styles.input, { color: text, borderColor: border, flex: 1 }]}
                />
                <TouchableOpacity onPress={onApply} disabled={applying} style={[styles.primaryBtn, { paddingHorizontal: 20 }]}>
                  {applying ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryBtnText}>Apply</Text>}
                </TouchableOpacity>
              </View>
            </View>
          ) : null}

          {/* Friends */}
          <Text style={[styles.section, { color: sub }]}>AAPKE INVITED FRIENDS</Text>
          {data.referrals.length === 0 ? (
            <View style={[styles.card, { backgroundColor: card, borderColor: border, alignItems: 'center' }]}>
              <Ionicons name="people-outline" size={32} color={sub} />
              <Text style={[styles.fine, { color: sub, textAlign: 'center' }]}>Abhi tak koi nahi. Pehla invite bhejo!</Text>
            </View>
          ) : (
            data.referrals.map((r) => (
              <View key={r.id} style={[styles.friend, { backgroundColor: card, borderColor: border }]}>
                {r.avatarUrl ? (
                  <Image source={{ uri: r.avatarUrl }} style={styles.avatar} />
                ) : (
                  <View style={[styles.avatar, { backgroundColor: BRAND, alignItems: 'center', justifyContent: 'center' }]}>
                    <Text style={{ color: '#fff', fontFamily: 'Urbanist-Bold' }}>{(r.username || '?').slice(0, 1).toUpperCase()}</Text>
                  </View>
                )}
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={[styles.friendName, { color: text }]}>@{r.username || 'user'}</Text>
                  <Text style={[styles.fine, { color: sub, marginTop: 2 }]}>
                    {r.status === 'rewarded'
                      ? r.reward > 0
                        ? `+${r.reward} coins mile`
                        : 'Dost ko reward mila (aapki limit poori)'
                      : r.status === 'pending' && program
                        ? `${QUALIFY_COPY[program.qualifyAction].short} ka intezaar${r.expiresAt ? ` · ${new Date(r.expiresAt).toLocaleDateString()} tak` : ''}`
                        : r.status === 'review'
                          ? 'Review mein'
                          : r.status === 'expired'
                            ? 'Time par qualify nahi kiya'
                            : 'Eligible nahi'}
                  </Text>
                </View>
                <StatusPill status={r.status} />
              </View>
            ))
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function StatusPill({ status }: { status: ReferralStatus }) {
  const s = STATUS[status] ?? STATUS.pending;
  return (
    <View style={[styles.pill, { backgroundColor: s.bg }]}>
      <Text style={[styles.pillText, { color: s.color }]}>{s.label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', height: 56, paddingHorizontal: 16 },
  headerTitle: { fontSize: 20, fontFamily: 'Urbanist-Bold' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  hero: { backgroundColor: BRAND, borderRadius: 20, padding: 20, alignItems: 'center', marginBottom: 16 },
  heroTitle: { color: '#fff', fontSize: 20, fontFamily: 'Urbanist-Bold', marginTop: 10, textAlign: 'center' },
  heroSub: { color: '#FFE4E8', fontSize: 14, fontFamily: 'Urbanist-SemiBold', marginTop: 6, textAlign: 'center' },
  card: { borderRadius: 16, borderWidth: 1, padding: 16, marginBottom: 16 },
  cardTitle: { fontSize: 16, fontFamily: 'Urbanist-Bold' },
  label: { fontSize: 12, fontFamily: 'Urbanist-Bold', letterSpacing: 1 },
  codeBox: {
    marginTop: 10,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  code: { fontSize: 24, fontFamily: 'Urbanist-Bold', letterSpacing: 2 },
  link: { fontSize: 12, fontFamily: 'Urbanist-Medium', marginTop: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  primaryBtn: {
    backgroundColor: BRAND,
    borderRadius: 999,
    height: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 16,
  },
  primaryBtnText: { color: '#fff', fontSize: 15, fontFamily: 'Urbanist-Bold' },
  waBtn: { backgroundColor: '#25D366', width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  statsRow: { flexDirection: 'row', gap: 8, marginBottom: 16 },
  stat: { flex: 1, borderRadius: 14, borderWidth: 1, paddingVertical: 12, alignItems: 'center' },
  statValue: { fontSize: 18, fontFamily: 'Urbanist-Bold' },
  statLabel: { fontSize: 11, fontFamily: 'Urbanist-Medium', marginTop: 2, textAlign: 'center' },
  step: { flexDirection: 'row', alignItems: 'flex-start', marginTop: 12 },
  stepDot: { width: 24, height: 24, borderRadius: 12, backgroundColor: '#FFE4E8', alignItems: 'center', justifyContent: 'center' },
  stepNum: { color: BRAND, fontFamily: 'Urbanist-Bold', fontSize: 12 },
  stepText: { fontSize: 14, fontFamily: 'Urbanist-Medium', marginLeft: 10, flexShrink: 1 },
  fine: { fontSize: 12, fontFamily: 'Urbanist-Medium', marginTop: 12 },
  bar: { height: 8, borderRadius: 4, marginTop: 6, overflow: 'hidden' },
  barFill: { height: 8, borderRadius: 4 },
  input: { height: 48, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, fontFamily: 'Urbanist-SemiBold', letterSpacing: 1 },
  section: { fontSize: 12, fontFamily: 'Urbanist-Bold', letterSpacing: 1, marginBottom: 10, marginTop: 4 },
  friend: { flexDirection: 'row', alignItems: 'center', borderRadius: 14, borderWidth: 1, padding: 12, marginBottom: 10 },
  avatar: { width: 40, height: 40, borderRadius: 20 },
  friendName: { fontSize: 15, fontFamily: 'Urbanist-Bold' },
  pill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  pillText: { fontSize: 11, fontFamily: 'Urbanist-Bold' },
});
