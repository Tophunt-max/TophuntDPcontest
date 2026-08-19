import { Migration } from '@nozbe/watermelondb';

export const migrations: Migration[] = [
  {
    id: '1',
    name: 'Initial schema for stories offline support',
    createdAt: Date.now(),
  },
];
