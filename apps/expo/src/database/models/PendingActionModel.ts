import { Model } from '@nozbe/watermelondb';
import { field, text, readonly, date, number } from '@nozbe/watermelondb/decorators';

export type PendingActionType = 'view' | 'reaction' | 'create' | 'delete';

export interface PendingActionData {
  storyId?: string;
  emoji?: string;
  userId?: string;
  [key: string]: any;
}

export class PendingActionModel extends Model {
  static table = 'pending_actions';

  @field('id')
  id!: string;

  @field('type')
  type!: PendingActionType;

  @field('story_id')
  storyId!: string;

  @field('user_id')
  userId!: string;

  @field('data')
  data!: string; // JSON string of PendingActionData

  @field('timestamp')
  timestamp!: number;

  @field('retries')
  retries!: number;

  @readonly @date('updated_at')
  updatedAt!: number;

  // Helper to get data as object
  getData(): PendingActionData {
    if (!this.data) return {};
    try {
      return JSON.parse(this.data);
    } catch {
      return {};
    }
  }

  // Helper to set data from object
  setData(data: PendingActionData): void {
    this.data = JSON.stringify(data);
  }
}
