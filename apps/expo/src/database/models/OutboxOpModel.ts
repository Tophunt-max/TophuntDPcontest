import { Model } from '@nozbe/watermelondb';
import { field, date, readonly } from '@nozbe/watermelondb/decorators';

/**
 * One queued social action waiting to reach the server (src/sync/outbox.ts).
 *
 * Rows are coalesced by `opKey` (`account|kind|target`), so there is at most
 * one row per thing the user changed: liking then unliking a battle offline
 * leaves one row holding the LAST intent. `revision` increases on every
 * rewrite so a send that was in flight while the user changed their mind
 * cannot delete the newer intent when it completes.
 */
export class OutboxOpModel extends Model {
  static table = 'outbox_ops';

  @field('account') account!: string;
  @field('kind') kind!: string;
  @field('target') target!: string;
  @field('op_key') opKey!: string;
  /** JSON: the target state, e.g. {"liked":true}. */
  @field('payload') payload!: string;
  /** 'pending' | 'failed' (permanent rejection or out of attempts). */
  @field('status') status!: string;
  @field('attempts') attempts!: number;
  @field('revision') revision!: number;
  @field('next_attempt_at') nextAttemptAt!: number;
  @field('last_error') lastError?: string | null;
  @field('created_at') createdAt!: number;
  @readonly @date('updated_at') updatedAt!: Date;
}
