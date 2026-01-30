-- Migration v2: Add status timestamps
ALTER TABLE messages ADD COLUMN delivered_at INTEGER;
ALTER TABLE messages ADD COLUMN seen_at INTEGER;

-- Create index for performance
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
