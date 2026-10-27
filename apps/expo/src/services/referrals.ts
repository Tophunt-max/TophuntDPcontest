/**
 * Referral program client (server: apps/worker/src/lib/referralProgram.ts).
 *
 * A friend's code is applied at signup (or within the program's apply window),
 * which creates a PENDING referral. Both sides are paid only once the invited
 * friend completes the admin-chosen qualifying action. There is no signup bonus.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useQuery } from '@tanstack/react-query';
import { callApi, readApiLive } from '@/src/services/api';
import { getDeviceId } from '@/src/lib/deviceId';

export type QualifyAction = 'signup' | 'verified' | 'first_contest' | 'first_purchase';
export type ReferralStatus = 'pending' | 'review' | 'rewarded' | 'rejected' | 'expired';

export interface ReferralProgramPublic {
  enabled: boolean;
  referrerReward: number;
  refereeReward: number;
  qualifyAction: QualifyAction;
  applyWindowDays: number;
  qualifyWindowDays: number;
  milestones: { count: number; bonus: number }[];
}

export interface ReferralSummary {
  program: ReferralProgramPublic;
  code: string | null;
  link: string | null;
  stats: { invited: number; successful: number; pending: number; earned: number };
  referrals: {
    id: string;
    username: string | null;
    avatarUrl: string | null;
    status: ReferralStatus;
    reward: number;
    createdAt: number;
    rewardedAt: number | null;
    expiresAt: number | null;
  }[];
  referredBy: { status: ReferralStatus; reward: number; qualifyAction: QualifyAction | null; expiresAt: number | null } | null;
  canApply: boolean;
  applyUntil: number | null;
}

/** What the friend must do, in the app's voice. */
export const QUALIFY_COPY: Record<QualifyAction, { short: string; step: string }> = {
  signup: { short: 'sign up', step: 'Dost TopHunt par signup kare' },
  verified: { short: 'email aur mobile verify', step: 'Dost apna email aur mobile dono verify kare' },
  first_contest: { short: 'pehla contest join', step: 'Dost apna pehla contest join kare' },
  first_purchase: { short: 'pehli Diamond purchase', step: 'Dost apni pehli Diamond purchase kare' },
};

export const REFERRALS_QUERY_KEY = ['me', 'referrals'] as const;

export function useMyReferrals(enabled = true) {
  return useQuery({
    queryKey: REFERRALS_QUERY_KEY,
    queryFn: () => readApiLive('/read/me/referrals') as Promise<ReferralSummary>,
    enabled,
    staleTime: 15_000,
  });
}

export type ApplyOutcome =
  | { status: 'applied'; referralStatus: ReferralStatus; qualifyAction: QualifyAction }
  | { status: 'already_referred' }
  | { status: 'refused'; message: string };

/** Apply a friend's code after signup (within the apply window). */
export async function applyReferralCode(code: string): Promise<ApplyOutcome> {
  const deviceId = await getDeviceId().catch(() => null);
  return (await callApi('applyReferralCode', { code: normalizeReferralCode(code), deviceId })) as ApplyOutcome;
}

export function normalizeReferralCode(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '')
    .slice(0, 32);
}

// ---------------------------------------------------------------------------
// A code from an invite link (/invite/CODE or ?ref=CODE), kept until signup.
// ---------------------------------------------------------------------------

const PENDING_KEY = 'tophunt.pendingReferralCode';
const PENDING_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export async function savePendingInvite(code: string): Promise<void> {
  const c = normalizeReferralCode(code);
  if (c.length < 4) return;
  try {
    await AsyncStorage.setItem(PENDING_KEY, JSON.stringify({ code: c, at: Date.now() }));
  } catch {
    /* best-effort */
  }
}

export async function getPendingInvite(): Promise<string | null> {
  try {
    const raw = await AsyncStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const { code, at } = JSON.parse(raw);
    if (!code || Date.now() - Number(at) > PENDING_TTL_MS) {
      await AsyncStorage.removeItem(PENDING_KEY);
      return null;
    }
    return String(code);
  } catch {
    return null;
  }
}

export async function clearPendingInvite(): Promise<void> {
  try {
    await AsyncStorage.removeItem(PENDING_KEY);
  } catch {
    /* best-effort */
  }
}

/** One-line description of the offer, for signup / invite screens. */
export function offerLine(p: Pick<ReferralProgramPublic, 'refereeReward' | 'qualifyAction'> | null | undefined): string | null {
  if (!p || !(p.refereeReward > 0)) return null;
  return p.qualifyAction === 'signup'
    ? `Friend ka code lagao aur ${p.refereeReward} Diamond pao!`
    : `Friend ka code lagao — ${QUALIFY_COPY[p.qualifyAction].short} karte hi ${p.refereeReward} Diamond milenge!`;
}
