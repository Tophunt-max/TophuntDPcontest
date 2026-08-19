import { Model } from '@nozbe/watermelondb';
import { field, text, readonly, date, boolean } from '@nozbe/watermelondb/decorators';

export class UserStoryModel extends Model {
  static table = 'user_stories';

  @field('user_id')
  userId!: string;

  @field('username')
  username!: string;

  @field('avatar_url')
  avatarUrl!: string;

  @field('has_unseen')
  hasUnseen!: boolean;

  @field('last_fetched')
  lastFetched!: number;

  @field('stories')
  stories!: string; // JSON string of story IDs

  @readonly @date('updated_at')
  updatedAt!: number;

  // Helper to get stories as array
  getStoryIds(): string[] {
    if (!this.stories) return [];
    try {
      return JSON.parse(this.stories);
    } catch {
      return [];
    }
  }

  // Helper to set stories from array
  setStoryIds(ids: string[]): void {
    this.stories = JSON.stringify(ids);
  }
}
