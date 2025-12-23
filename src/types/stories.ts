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
}

export interface UserStories {
  userId: string;
  username: string;
  avatarUrl: string;
  stories: Story[];
  hasUnseen: boolean;
}
