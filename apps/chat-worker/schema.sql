-- Migration for Chat System
CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    participants TEXT NOT NULL, -- JSON array of user IDs
    participants_data TEXT, -- JSON object for metadata (names, avatars)
    last_message TEXT, -- JSON object
    blocked_status TEXT, -- JSON object
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    type TEXT NOT NULL, -- text, image, voice_note, video_call, voice_call
    content TEXT NOT NULL,
    metadata TEXT, -- JSON string
    status TEXT DEFAULT 'sent', -- sent, delivered, seen
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY(chat_id) REFERENCES chats(id)
);

CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
