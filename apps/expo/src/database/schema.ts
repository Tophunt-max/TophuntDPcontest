import { appSchema, tableSchema } from '@nozbe/watermelondb';

/**
 * Local (offline) schema for the stories cache.
 *
 * Notes for anyone editing this file:
 *
 * - Do NOT declare an `id` column. WatermelonDB manages `id` itself on every
 *   table; adding it here and decorating it in a model shadows `Model#id` and
 *   breaks record identity.
 * - Every table declares `updated_at` because all three models expose a
 *   `@readonly @date('updated_at')` property. WatermelonDB touches that column
 *   automatically on write, so the column has to exist or the write fails.
 * - `created_at` / `expires_at` on `stories` hold the *server's* epoch-ms
 *   timestamps. Only `updated_at` is auto-managed by WatermelonDB, so these two
 *   are safe to own ourselves.
 */
export const schema = appSchema({
  version: 1,
  tables: [
    tableSchema({
      name: 'stories',
      columns: [
        { name: 'user_id', type: 'string', isIndexed: true },
        { name: 'username', type: 'string' },
        { name: 'avatar_url', type: 'string' },
        { name: 'media_url', type: 'string' },
        { name: 'media_type', type: 'string' }, // 'image' | 'video'
        { name: 'created_at', type: 'number' }, // server timestamp, epoch ms
        { name: 'expires_at', type: 'number', isIndexed: true }, // epoch ms
        { name: 'seen', type: 'boolean' },
        { name: 'overlay_text', type: 'string', isOptional: true },
        { name: 'text_position', type: 'string', isOptional: true }, // JSON
        { name: 'mentions', type: 'string', isOptional: true }, // JSON
        { name: 'is_synced', type: 'boolean', isIndexed: true },
        { name: 'updated_at', type: 'number' },
      ],
    }),
    tableSchema({
      name: 'user_stories',
      columns: [
        // Mirrors the record id, kept as a column so it stays queryable.
        { name: 'user_id', type: 'string', isIndexed: true },
        { name: 'username', type: 'string' },
        { name: 'avatar_url', type: 'string' },
        { name: 'has_unseen', type: 'boolean' },
        { name: 'last_fetched', type: 'number' },
        { name: 'stories', type: 'string' }, // JSON array of story ids
        { name: 'updated_at', type: 'number' },
      ],
    }),
    tableSchema({
      name: 'pending_actions',
      columns: [
        { name: 'type', type: 'string', isIndexed: true }, // view | reaction | create | delete
        { name: 'story_id', type: 'string' },
        { name: 'user_id', type: 'string' },
        { name: 'data', type: 'string' }, // JSON payload
        { name: 'timestamp', type: 'number', isIndexed: true },
        { name: 'retries', type: 'number' },
        { name: 'updated_at', type: 'number' },
      ],
    }),
  ],
});
