-- TopHunt D1 schema (replaces Firestore). Generated to match src/db/schema.ts.

CREATE TABLE IF NOT EXISTS users (
  uid TEXT PRIMARY KEY,
  email TEXT,
  username TEXT,
  full_name TEXT,
  profile_image_url TEXT,
  dob TEXT,
  phone TEXT,
  occupation TEXT,
  gender TEXT,
  platform TEXT DEFAULT 'unknown',
  coordinates TEXT,
  role TEXT DEFAULT 'user',
  status TEXT DEFAULT 'active',
  is_blocked INTEGER DEFAULT 0,
  dpcoin REAL DEFAULT 0,
  xp INTEGER DEFAULT 0,
  level INTEGER DEFAULT 1,
  badges TEXT DEFAULT '[]',
  equipped_badge TEXT,
  streak INTEGER DEFAULT 0,
  last_daily_claim INTEGER,
  followers_count INTEGER DEFAULT 0,
  following_count INTEGER DEFAULT 0,
  posts_count INTEGER DEFAULT 0,
  wins INTEGER DEFAULT 0,
  monthly_wins INTEGER DEFAULT 0,
  total_votes_received INTEGER DEFAULT 0,
  contests_joined INTEGER DEFAULT 0,
  fcm_tokens TEXT DEFAULT '[]',
  signup_completed INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users (username);
CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);
CREATE INDEX IF NOT EXISTS idx_users_phone ON users (phone);
CREATE INDEX IF NOT EXISTS idx_users_monthly_wins ON users (monthly_wins);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_users_username ON users (username) WHERE username IS NOT NULL;

CREATE TABLE IF NOT EXISTS follows (
  follower_id TEXT NOT NULL,
  following_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (follower_id, following_id)
);
CREATE INDEX IF NOT EXISTS idx_follows_following ON follows (following_id);

CREATE TABLE IF NOT EXISTS contests (
  id TEXT PRIMARY KEY,
  title TEXT,
  type TEXT DEFAULT 'photo',
  status TEXT DEFAULT 'live',
  total_entry_fee REAL DEFAULT 0,
  reward_coins REAL DEFAULT 0,
  vote_duration_days INTEGER DEFAULT 1,
  auto_cancel_hours INTEGER DEFAULT 24,
  min_votes INTEGER DEFAULT 0,
  extra TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS contest_matches (
  id TEXT PRIMARY KEY,
  contest_id TEXT,
  status TEXT NOT NULL,
  type TEXT DEFAULT 'photo',
  title TEXT,
  entry_fee REAL DEFAULT 0,
  is_private INTEGER DEFAULT 0,
  invited_uid TEXT,
  join_id_a TEXT,
  join_id_b TEXT,
  user_a TEXT,
  user_b TEXT,
  total_votes INTEGER DEFAULT 0,
  like_count INTEGER DEFAULT 0,
  comment_count INTEGER DEFAULT 0,
  share_count INTEGER DEFAULT 0,
  winner_uid TEXT,
  reward_amount REAL DEFAULT 0,
  ending_soon_notified INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  activated_at INTEGER,
  completed_at INTEGER,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_matches_status ON contest_matches (status);
CREATE INDEX IF NOT EXISTS idx_matches_expires ON contest_matches (expires_at);
CREATE INDEX IF NOT EXISTS idx_matches_status_expires ON contest_matches (status, expires_at);

CREATE TABLE IF NOT EXISTS votes (
  id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL,
  voter_uid TEXT NOT NULL,
  voted_for_uid TEXT NOT NULL,
  device_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_votes_match ON votes (match_id);

CREATE TABLE IF NOT EXISTS coin_transactions (
  id TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  amount REAL NOT NULL,
  type TEXT NOT NULL,
  contest_id TEXT,
  match_id TEXT,
  description TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_txn_uid ON coin_transactions (uid);
CREATE INDEX IF NOT EXISTS idx_txn_created ON coin_transactions (created_at);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  amount REAL NOT NULL,
  status TEXT DEFAULT 'success',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  media_url TEXT,
  media_type TEXT DEFAULT 'photo',
  caption TEXT,
  location TEXT,
  like_count INTEGER DEFAULT 0,
  comment_count INTEGER DEFAULT 0,
  is_hidden INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_user ON posts (user_id);

CREATE TABLE IF NOT EXISTS post_likes (
  post_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE IF NOT EXISTS post_comments (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  text TEXT,
  parent_id TEXT,
  like_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_post ON post_comments (post_id);

CREATE TABLE IF NOT EXISTS comment_likes (
  comment_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (comment_id, user_id)
);

CREATE TABLE IF NOT EXISTS stories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  username TEXT,
  avatar_url TEXT,
  media_url TEXT,
  media_type TEXT DEFAULT 'photo',
  visibility TEXT DEFAULT 'public',
  overlay_text TEXT,
  text_position TEXT,
  mentions TEXT,
  type TEXT,
  match_id TEXT,
  contest_title TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stories_user ON stories (user_id);
CREATE INDEX IF NOT EXISTS idx_stories_expires ON stories (expires_at);

CREATE TABLE IF NOT EXISTS story_views (
  story_id TEXT NOT NULL,
  viewer_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (story_id, viewer_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  recipient_id TEXT NOT NULL,
  title TEXT,
  body TEXT,
  type TEXT,
  target_id TEXT,
  image TEXT,
  data TEXT,
  read INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_recipient ON notifications (recipient_id, created_at);

CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  users TEXT,
  users_data TEXT,
  last_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  text TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages (chat_id, created_at);

CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  target_type TEXT,
  target_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS profile_visits (
  user_id TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, visitor_id)
);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  reporter_id TEXT,
  target_type TEXT,
  target_id TEXT,
  reason TEXT,
  status TEXT DEFAULT 'open',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS support_tickets (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  subject TEXT,
  message TEXT,
  status TEXT DEFAULT 'open',
  admin_reply TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
