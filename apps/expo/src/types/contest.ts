import { Timestamp } from 'firebase/firestore';

export type ContestStatus = 'upcoming' | 'live' | 'ended';
export type MediaType = 'photo' | 'video';

export interface Contest {
  id: string;
  name: string;
  type: MediaType;
  rules: string;
  bannerUrl?: string; // Added optional bannerUrl
  entryFishCoins: number; // Total entry fee (e.g., 100)
  winningCoins: number;   // Main prize
  DpcoinReward: number; // Bonus reward
  minimumVotes: number;   // Eligibility for winning
  startDate: Timestamp;
  endDate: Timestamp;
  status: ContestStatus;
  createdAt: Timestamp;
  createdBy: string; // Admin UID
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
