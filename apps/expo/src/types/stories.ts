import { Timestamp } from 'firebase/firestore';

export interface Story {
  id: string;
  userId: string;
  username?: string;
  avatarUrl?: string;
  mediaUrl: string;
  mediaType: 'image' | 'video';
  createdAt: Timestamp;
  expiresAt: Timestamp;
  seen?: boolean;
  // Optional creative overlays attached to a story.
  overlayText?: string;
  textPosition?: { x: number; y: number } | any;
  mentions?: any[];
}

export interface UserStories {
  userId: string;
  username: string;
  avatarUrl: string;
  stories: Story[];
  hasUnseen?: boolean;
}
