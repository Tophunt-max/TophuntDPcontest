import { Timestamp } from 'firebase/firestore';

export type ContestStatus = 'upcoming' | 'live' | 'ended';
export type MediaType = 'photo' | 'video';

/**
 * A contest template as `/read/contests` actually returns it.
 *
 * This used to describe the Firestore document instead of the Worker response,
 * so `startDate` / `endDate` were declared as Firestore `Timestamp`s that the
 * Worker has never sent, and callers worked around the type with loose
 * `item.foo || item.bar` reads. The wire shape is defined by `mapContest` in
 * apps/worker/src/routes/read.ts — keep the two in step.
 */
export interface Contest {
  id: string;
  /** Both are sent, and are the same string. */
  title: string;
  name: string;
  type: MediaType;
  rules?: string;
  description?: string;
  bannerUrl?: string | null;
  status: ContestStatus;

  /** Entry pot for BOTH players. Aliases of the same number. */
  totalEntryFee: number;
  entryFishCoins: number;
  entryDpcoin: number;
  /**
   * What ONE player is charged — already halved and floored by the server.
   * Prefer this over halving a total yourself; see src/lib/contestPricing.ts.
   */
  entryFeePerPlayer: number;
  /** True when neither player pays to enter. */
  isFree: boolean;

  /** Winner's prize. Aliases of the same number. */
  rewardCoins: number;
  winningCoins: number;

  /**
   * Validity window in epoch MILLISECONDS; null means unbounded. Absolute
   * instants rather than a "time remaining", because the list response is
   * cached for 60s and a relative figure would arrive stale. The app counts
   * down against `endsAt` locally — see src/hooks/useCountdown.ts.
   *
   * These govern the TEMPLATE's own lifetime. `voteDurationDays` and
   * `autoCancelHours` below time an individual match instead.
   */
  startsAt: number | null;
  endsAt: number | null;

  voteDurationDays: number;
  autoCancelHours: number;
  minVotes: number;

  /** Epoch milliseconds. */
  createdAt: number;
  createdBy: string | null;
}

export interface ContestEntry {
  id: string;
  contestId: string;
  userId: string;
  username: string;
  userDisplayName: string;
  mediaUrl: string;
  caption?: string;
  status: 'waiting' | 'paired';
  battleId?: string; 
  createdAt: Timestamp;
}

export interface Battle {
  id: string;
  contestId: string;
  contestName: string;
  contestType: MediaType;
  userA: BattleParticipant;
  userB: BattleParticipant;
  totalVotes: number;
  status: 'active' | 'ended';
  winnerId?: string;
  endDate: Timestamp; 
  createdAt: Timestamp;
}

export interface BattleParticipant {
  userId: string;
  username: string;
  displayName: string;
  profileImageUrl?: string;
  mediaUrl: string;
  votes: number;
}

export interface Vote {
  id: string; // `${userId}_${battleId}`
  battleId: string;
  voterId: string;
  votedFor: string; // userId of participant
  contestId: string;
  createdAt: Timestamp;
}
