import { AppSchema } from '@nozbe/watermelondb';

export const schema: AppSchema = {
  version: 1,
  tables: [
    {
      name: 'stories',
      columns: [
        { name: 'id', type: 'string', isIndexed: true },
        { name: 'user_id', type: 'string', isIndexed: true },
        { name: 'username', type: 'string' },
        { name: 'avatar_url', type: 'string' },
        { name: 'media_url', type: 'string' },
        { name: 'media_type', type: 'string' }, // 'image' or 'video'
        { name: 'created_at', type: 'number' },
        { name: 'expires_at', type: 'number' },
        { name: 'seen', type: 'boolean' },
        { name: 'overlay_text', type: 'string', isOptional: true },
        { name: 'text_position', type: 'string', isOptional: true }, // JSON string
        { name: 'mentions', type: 'string', isOptional: true }, // JSON string
        { name: 'is_synced', type: 'boolean', isIndexed: true }, // Whether synced with server
        { name: 'updated_at', type: 'number' },
      ],
    },
    {
      name: 'user_stories',
      columns: [
        { name: 'user_id', type: 'string', isIndexed: true },
        { name: 'username', type: 'string' },
        { name: 'avatar_url', type: 'string' },
        { name: 'has_unseen', type: 'boolean' },
        { name: 'last_fetched', type: 'number' },
        { name: 'stories', type: 'string' }, // JSON string of story IDs
      ],
    },
    {
      name: 'pending_actions',
      columns: [
        { name: 'id', type: 'string', isIndexed: true },
        { name: 'type', type: 'string', isIndexed: true }, // 'view', 'reaction', 'create', 'delete'
        { name: 'story_id', type: 'string' },
        { name: 'user_id', type: 'string' },
        { name: 'data', type: 'string' }, // JSON string of action data
        { name: 'timestamp', type: 'number' },
        { name: 'retries', type: 'number' },
      ],
    },
  ],
};
