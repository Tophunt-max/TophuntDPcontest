import { Model } from '@nozbe/watermelondb';
import { field, date, readonly } from '@nozbe/watermelondb/decorators';

export class StoryModel extends Model {
  static table = 'stories';

  // `id` is inherited from Model and holds the server-side story id (assigned
  // through `_raw.id` at create time — see offlineStoryService). Never
  // redeclare it: `Model#id` is an accessor, and shadowing it with a decorated
  // instance property breaks record identity.

  @field('user_id') userId!: string;
  @field('username') username!: string;
  @field('avatar_url') avatarUrl!: string;
  @field('media_url') mediaUrl!: string;
  @field('media_type') mediaType!: 'image' | 'video';

  // Server timestamps, epoch milliseconds. Plain @field (not @date) so these
  // stay numbers and round-trip to the API shape without conversion.
  @field('created_at') createdAt!: number;
  @field('expires_at') expiresAt!: number;

  // Booleans use @field — `boolean` is NOT exported by watermelondb/decorators.
  @field('seen') seen!: boolean;
  @field('is_synced') isSynced!: boolean;

  @field('overlay_text') overlayText?: string;
  @field('text_position') textPosition?: string; // JSON: { x, y }
  @field('mentions') mentions?: string; // JSON: string[]

  // Auto-touched by WatermelonDB on every write. Do not assign manually.
  @readonly @date('updated_at') updatedAt!: Date;

  getTextPosition(): { x: number; y: number } | null {
    if (!this.textPosition) return null;
    try {
      return JSON.parse(this.textPosition);
    } catch {
      return null;
    }
  }

  getMentions(): string[] {
    if (!this.mentions) return [];
    try {
      const parsed = JSON.parse(this.mentions);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  isExpired(): boolean {
    return Date.now() > this.expiresAt;
  }
}
