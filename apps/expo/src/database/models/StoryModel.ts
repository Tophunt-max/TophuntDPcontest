import { Model } from '@nozbe/watermelondb';
import { field, text, readonly, date, boolean } from '@nozbe/watermelondb/decorators';

export class StoryModel extends Model {
  static table = 'stories';

  @field('id')
  id!: string;

  @field('user_id')
  userId!: string;

  @field('username')
  username!: string;

  @field('avatar_url')
  avatarUrl!: string;

  @field('media_url')
  mediaUrl!: string;

  @field('media_type')
  mediaType!: 'image' | 'video';

  @field('created_at')
  createdAt!: number;

  @field('expires_at')
  expiresAt!: number;

  @field('seen')
  seen!: boolean;

  @field('overlay_text')
  overlayText?: string;

  @field('text_position')
  textPosition?: string; // JSON string: { x: number, y: number }

  @field('mentions')
  mentions?: string; // JSON string: string[]

  @field('is_synced')
  isSynced!: boolean;

  @readonly @date('updated_at')
  updatedAt!: number;

  // Helper to get textPosition as object
  getTextPosition(): { x: number; y: number } | null {
    if (!this.textPosition) return null;
    try {
      return JSON.parse(this.textPosition);
    } catch {
      return null;
    }
  }

  // Helper to get mentions as array
  getMentions(): string[] {
    if (!this.mentions) return [];
    try {
      return JSON.parse(this.mentions);
    } catch {
      return [];
    }
  }

  // Check if story is expired
  isExpired(): boolean {
    return Date.now() > this.expiresAt;
  }
}
