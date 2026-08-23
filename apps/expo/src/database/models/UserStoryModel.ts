import { Model } from '@nozbe/watermelondb';
import { field, date, readonly } from '@nozbe/watermelondb/decorators';

export class UserStoryModel extends Model {
  static table = 'user_stories';

  // The record `id` is set to the owning user's uid at create time, so
  // `collection.find(uid)` resolves a user's story group directly.
  @field('user_id') userId!: string;
  @field('username') username!: string;
  @field('avatar_url') avatarUrl!: string;
  @field('has_unseen') hasUnseen!: boolean;
  @field('last_fetched') lastFetched!: number;
  @field('stories') stories!: string; // JSON array of story ids

  // Auto-touched by WatermelonDB on every write. Do not assign manually.
  @readonly @date('updated_at') updatedAt!: Date;

  getStoryIds(): string[] {
    if (!this.stories) return [];
    try {
      const parsed = JSON.parse(this.stories);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
}
