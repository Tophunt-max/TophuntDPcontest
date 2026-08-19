// Database setup for WatermelonDB
import { Database } from '@nozbe/watermelondb';
import SQLiteAdapter from '@nozbe/watermelondb/adapters/sqlite';
import { schema } from './schema';
import { migrations } from './migrations';
import { StoryModel } from './models/StoryModel';
import { UserStoryModel } from './models/UserStoryModel';
import { PendingActionModel } from './models/PendingActionModel';

// SQLite adapter for React Native
const adapter = new SQLiteAdapter({
  schema,
  migrations,
  dbName: 'tophunt_stories',
  jsi: true, // Enable JSI for better performance
});

// Initialize database
export const database = new Database({
  adapter,
  modelClasses: [StoryModel, UserStoryModel, PendingActionModel],
});

// Export models for use in other files
export { StoryModel, UserStoryModel, PendingActionModel };
