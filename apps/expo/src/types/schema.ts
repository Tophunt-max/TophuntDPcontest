import { Timestamp } from 'firebase/firestore';

/**
 * PRODUCTION-GRADE FIRESTORE SCHEMA
 */

// ============================================================================
// 1. USERS COLLECTION ('users')
// ============================================================================
export interface UserProfile {
  uid: string;
  username: string; 
  fullName: string;
  email: string;
  profileImageUrl?: string;
  bio?: string;
  website?: string;
  gender?: string;
  phone?: string;
  occupation?: string;
  socials?: {
    facebook?: string;
    twitter?: string;
    instagram?: string;
  };
  Dpcoin: number; 
  xp: number;
  level: number;
  badges: string[]; 
  isAdmin: boolean;
  isPrivate: boolean;

  // Blocking System
  blockedUsers?: string[]; 

  stats: {
    postsCount: number;
    followersCount: number;
    followingCount: number;
    contestsJoined: number;
    wins: number;
    totalVotesReceived: number;
  };

  fcmToken?: string; 
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
  thumbnailUrl?: string; 
  mediaType: 'image' | 'video';
  caption?: string;
  likesCount: number;
  commentsCount: number;
  createdAt: Timestamp;
  updatedAt?: Timestamp;
}

// ============================================================================
// 3. CONTESTS & BATTLES
// ============================================================================
export interface Contest {
  id: string;
  name: string;
  description?: string;
  type: 'photo' | 'video'; 
  status: 'upcoming' | 'live' | 'ended';
  entryFee: number;
  prizePool: number;
  winningCoins: number; 
  minVotesToQualify: number;
  startDate: Timestamp;
  endDate: Timestamp;
  createdBy: string; 
  createdAt: Timestamp;
}

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

export interface Battle {
  id: string;
  contestId: string;
  contestType: 'photo' | 'video';
  userA: {
    userId: string;
    username: string;
    displayName: string;
    avatarUrl?: string;
    mediaUrl: string;
    votes: number;
  };
  userB: {
    userId: string;
    username: string;
    displayName: string;
    avatarUrl?: string;
    mediaUrl: string;
    votes: number;
  };
  totalVotes: number;
  winnerId?: string; 
  status: 'active' | 'ended';
  createdAt: Timestamp;
  expiresAt: Timestamp;
}

export interface Vote {
  id: string; 
  battleId: string;
  contestId: string;
  voterId: string;
  votedForUserId: string;
  createdAt: Timestamp;
}

// ============================================================================
// 4. STORIES, WALLET, NOTIFICATIONS
// ============================================================================
export interface Story {
  id: string;
  userId: string;
  mediaUrl: string;
  mediaType: 'image' | 'video';
  duration?: number; 
  createdAt: Timestamp;
  expiresAt: Timestamp; 
  viewersCount: number;
}

export interface Transaction {
  id: string;
  userId: string;
  type: 'deposit' | 'withdrawal' | 'entry_fee' | 'contest_win' | 'daily_bonus';
  amount: number;
  description: string;
  referenceId?: string; 
  createdAt: Timestamp;
}

export interface Notification {
  id: string;
  recipientId: string;
  senderId?: string;
  senderName?: string;
  senderAvatar?: string;
  type: 'like' | 'comment' | 'follow' | 'contest_start' | 'battle_win' | 'battle_loss' | 'message';
  title: string;
  body: string;
  read: boolean;
  data?: any; 
  createdAt: Timestamp;
}

// ============================================================================
// 5. MESSAGING SYSTEM
// ============================================================================
export interface Chat {
  id: string;
  participants: string[];
  participantsData: {
    [uid: string]: { displayName: string; photoURL: string; lastSeen?: Timestamp; };
  };
  lastMessage: {
    text: string;
    senderId: string;
    type: MessageType;
    createdAt: Timestamp;
  };
  unreadCount: { [uid: string]: number; };
  blockedBy?: string[]; 
  settings?: { backgroundImage?: string; };
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export type MessageType = 'text' | 'image' | 'voice_note' | 'video_message' | 'call_log';

export interface Message {
  id: string;
  chatId: string;
  senderId: string;
  type: MessageType;
  content: string;
  metadata?: {
    duration?: number;
    thumbnail?: string;
    width?: number;
    height?: number;
    callDuration?: number;
    callStatus?: 'missed' | 'completed' | 'declined';
  };
  status: 'sent' | 'delivered' | 'seen';
  createdAt: Timestamp;
}

export interface Report {
  id: string;
  reporterId: string;
  targetId: string;
  targetType: 'user' | 'post' | 'message' | 'story';
  reason: string;
  status: 'pending' | 'reviewed' | 'resolved';
  createdAt: Timestamp;
}
