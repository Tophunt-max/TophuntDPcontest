export interface UserProfile {
  uid: string;
  username: string;
  fullName: string;
  email: string;
  bio?: string;
  avatarUrl?: string;
  website?: string;
  isPrivate?: boolean;
}

export interface UserStats {
  postsCount: number;
  followersCount: number;
  followingCount: number;
  // Optional for UI consistency in some views
  likesCount?: number; 
}

export interface Post {
  id: string;
  userId: string;
  mediaUrl: string;
  thumbnailUrl?: string; // for videos
  mediaType: 'image' | 'video';
  caption?: string;
  createdAt: any; // Firestore Timestamp
  likesCount: number;
  commentsCount: number;
}

export interface Highlight {
  id: string;
  title: string;
  coverUrl: string;
  stories: string[]; // IDs of stories
}
