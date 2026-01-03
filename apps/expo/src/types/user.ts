import { Timestamp } from 'firebase/firestore';

export interface Badge {
  name: string;
  icon: string;
  level: number;
}

export interface UserProfile {
  uid: string;
  username: string;
  fullName: string;
  email: string;
  bio?: string;
  profileImageUrl?: string;
  website?: string;
  isPrivate?: boolean;
  occupation?: string;
  gender?: string;
  phone?: string;
  facebook?: string;
  twitter?: string;
  instagram?: string;
  
  // Array of user IDs this user is following
  following?: string[];

  // Contest Platform Fields
  Dpcoin: number; 
  isAdmin: boolean;
  xp?: number;
  level?: number;
  badges?: Badge[];
  equippedBadge?: Badge;
  
  stats: {
    contestsJoined: number;
    wins: number;
    totalVotesReceived: number;
  };
  createdAt: Timestamp;
}

export interface UserStats {
  postsCount: number;
  followersCount: number;
  followingCount: number;
  likesCount?: number; 
}

export interface Post {
  id: string;
  userId: string;
  mediaUrl: string;
  thumbnailUrl?: string; 
  mediaType: 'image' | 'video';
  caption?: string;
  createdAt: any; 
  likesCount: number;
  commentsCount: number;
}

export interface Highlight {
  id: string;
  title: string;
  coverUrl: string;
  stories: string[]; 
}

export interface CoinTransaction {
  id: string;
  userId: string;
  amount: number; 
  type: 'entry_fee' | 'win_reward' | 'bonus' | 'purchase';
  contestId?: string;
  battleId?: string;
  description: string;
  createdAt: Timestamp;
}
