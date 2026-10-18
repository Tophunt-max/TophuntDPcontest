import { Model } from '@nozbe/watermelondb';
import { field, date, readonly } from '@nozbe/watermelondb/decorators';

/**
 * One Home feed first-page snapshot for one (viewer, tab).
 *
 * `id` is inherited from Model and is assigned `${owner}|${tab}` through `_raw.id`
 * at create time (see src/lib/feedSnapshot.ts) — never redeclare it here.
 */
export class FeedSnapshotModel extends Model {
  static table = 'feed_snapshots';

  @field('owner') owner!: string;
  @field('tab') tab!: string;
  @field('items') items!: string; // JSON array
  @field('next_cursor') nextCursor!: string | null;
  @field('fetched_at') fetchedAt!: number;
  @field('format') format!: number;

  // Auto-touched by WatermelonDB on every write. Do not assign manually.
  @readonly @date('updated_at') updatedAt!: Date;
}
