import { Timestamp } from 'firebase/firestore';

/**
 * PRODUCTION-GRADE FIRESTORE SCHEMA
 * 
 * This file acts as the central source of truth for our data models.
 * It is designed for scalability, minimal reads, and type safety.
 */

// ============================================================================
// 1. USERS COLLECTION ('users')
// ============================================================================
export interface UserProfile {
  uid: string;
  username: string; // Indexed, unique
  fullName: string;
  email: string;
  profileImageUrl?: string;
  bio?: string;
  website?: string;
  
  // Demographics (Optional)
  gender?: string;
  phone?: string;
  occupation?: string;
  
  // Social Links
  socials?: {
    facebook?: string;
    twitter?: string;
    instagram?: string;
  };

  // Gamification & Wallet
  fishCoins: number; // Virtual Currency
  xp: number;
  level: number;
  badges: string[]; // Array of badge IDs
  
  // Role
  isAdmin: boolean;
  isPrivate: boolean;

  // Aggregated Stats (For fast profile reads without counting documents)
  stats: {
    postsCount: number;
    followersCount: number;
    followingCount: number;
    contestsJoined: number;
    wins: number;
    totalVotesReceived: number;
  };

  fcmToken?: string; // For Push Notifications
  
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ============================================================================
// 2. POSTS COLLECTION ('posts')
// ============================================================================
export interface Post {
  id: string;
  userId: string;
  
  mediaUrl: string;
  thumbnailUrl?: string; // Required if mediaType is video
  mediaType: 'image' | 'video';
  caption?: string;
  
  // Engagement Metrics
  likesCount: number;
  commentsCount: number;
  
  createdAt: Timestamp;
  updatedAt?: Timestamp;
}

// ============================================================================
// 3. CONTESTS SYSTEM
// ============================================================================

// Collection: 'contests'
export interface Contest {
  id: string;
  name: string;
  description?: string;
  type: 'photo' | 'video'; // Contest limitation
  status: 'upcoming' | 'live' | 'ended';
  
  // Rules & Economy
  entryFee: number;
  prizePool: number;
  winningCoins: number; // Reward for winner
  
  // Voting Rules
  minVotesToQualify: number;
  
  startDate: Timestamp;
  endDate: Timestamp;
  
  createdBy: string; // Admin UID
  createdAt: Timestamp;
}

// Sub-collection: 'contests/{contestId}/entries'
export interface ContestEntry {
  id: string;
  contestId: string;
  userId: string;
  username: string;
  userAvatar?: string;
  
  mediaUrl: string;
  caption?: string;
  
  status: 'waiting' | 'approved' | 'rejected' | 'paired';
  
  createdAt: Timestamp;
}

// Collection: 'battles' (Top-level for easier querying of active battles)
export interface Battle {
  id: string;
  contestId: string;
  contestType: 'photo' | 'video';
  
  // Participant A
  userA: {
    userId: string;
    username: string;
    displayName: string;
    avatarUrl?: string;
    mediaUrl: string;
    votes: number;
  };
  
  // Participant B
  userB: {
    userId: string;
    username: string;
    displayName: string;
    avatarUrl?: string;
    mediaUrl: string;
    votes: number;
  };
  
  totalVotes: number;
  winnerId?: string; // Populated when battle ends
  status: 'active' | 'ended';

  createdAt: Timestamp;
  expiresAt: Timestamp;
}

// Collection: 'votes' (To prevent double voting and audit)
export interface Vote {
  id: string; // Composite: `${battleId}_${userId}`
  battleId: string;
  contestId: string;
  voterId: string;
  votedForUserId: string;
  createdAt: Timestamp;
}

// ============================================================================
// 4. STORIES COLLECTION ('stories')
// ============================================================================
export interface Story {
  id: string;
  userId: string;
  mediaUrl: string;
  mediaType: 'image' | 'video';
  duration?: number; // for video
  
  createdAt: Timestamp;
  expiresAt: Timestamp; // createdAt + 24 hours
  
  viewersCount: number;
}

// ============================================================================
// 5. WALLET & TRANSACTIONS ('transactions')
// ============================================================================
export interface Transaction {
  id: string;
  userId: string;
  type: 'deposit' | 'withdrawal' | 'entry_fee' | 'contest_win' | 'daily_bonus';
  amount: number;
  description: string;
  
  referenceId?: string; // contestId, battleId, etc.
  
  createdAt: Timestamp;
}

// ============================================================================
// 6. NOTIFICATIONS ('notifications')
// ============================================================================
export interface Notification {
  id: string;
  recipientId: string;
  senderId?: string; // Optional (e.g. system msg)
  senderName?: string;
  senderAvatar?: string;
  
  type: 'like' | 'comment' | 'follow' | 'contest_start' | 'battle_win' | 'battle_loss';
  title: string;
  body: string;
  
  read: boolean;
  data?: any; // Deep link data
  
  createdAt: Timestamp;
}
