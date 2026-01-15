import { Timestamp } from 'firebase/firestore';

export interface Story {
  id: string;
  userId: string;
  username: string; // Denormalized for speed
  avatarUrl: string; // Denormalized for speed
  mediaUrl: string; // CDN URL (CloudFront / Cloudflare)
  thumbnailUrl?: string; // Small WebP thumbnail for instant loading
  mediaType: 'image' | 'video';
  createdAt: Timestamp;
  expiresAt: Timestamp;
  viewsCount?: number; // Aggregated by Cloud Function
  seen?: boolean;
  mentions?: string[];
  overlayText?: string;
  textPosition?: { x: number, y: number };
}

export interface UserStories {
  userId: string;
  username: string;
  avatarUrl: string;
  stories: Story[];
  hasUnseen: boolean;
}
