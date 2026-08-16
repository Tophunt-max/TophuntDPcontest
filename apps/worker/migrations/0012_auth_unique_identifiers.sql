-- Enforce identifier uniqueness on users(username / email / phone).
--
-- Previously these were plain (non-unique) indexes, so two accounts could end
-- up sharing a username or phone (the app only checked availability client-side,
-- with a TOCTOU race and no DB guarantee). This migration makes them UNIQUE.
--
-- To avoid bricking the auto-migrator on a DB that already contains duplicates,
-- we FIRST de-duplicate existing rows (non-destructively — no account is
-- deleted), keeping the earliest-created row's value and neutralising the later
-- ones, THEN create partial unique indexes. Idempotent + safe to re-run.

-- Normalise casing so uniqueness is effectively case-insensitive for stored data
-- (the app already lowercases usernames; align emails to match the lookup path).
UPDATE users SET email = lower(email) WHERE email IS NOT NULL AND email <> lower(email);
UPDATE users SET username = lower(username) WHERE username IS NOT NULL AND username <> lower(username);

-- De-duplicate usernames: keep the earliest account, suffix later duplicates.
UPDATE users
SET username = username || '_dup' || substr(uid, 1, 6)
WHERE uid IN (
  SELECT uid FROM (
    SELECT uid, ROW_NUMBER() OVER (
      PARTITION BY username ORDER BY created_at ASC, uid ASC
    ) AS rn
    FROM users WHERE username IS NOT NULL AND username <> ''
  ) WHERE rn > 1
);

-- De-duplicate phones: a phone can only belong to one account. Null the later
-- duplicates (the owner keeps it; affected users can re-add + re-verify).
UPDATE users
SET phone = NULL
WHERE uid IN (
  SELECT uid FROM (
    SELECT uid, ROW_NUMBER() OVER (
      PARTITION BY phone ORDER BY created_at ASC, uid ASC
    ) AS rn
    FROM users WHERE phone IS NOT NULL AND phone <> ''
  ) WHERE rn > 1
);

-- De-duplicate emails (Firebase already enforces this at auth level, so this is
-- belt-and-braces): null later duplicates.
UPDATE users
SET email = NULL
WHERE uid IN (
  SELECT uid FROM (
    SELECT uid, ROW_NUMBER() OVER (
      PARTITION BY email ORDER BY created_at ASC, uid ASC
    ) AS rn
    FROM users WHERE email IS NOT NULL AND email <> ''
  ) WHERE rn > 1
);

-- Replace the non-unique indexes with partial UNIQUE indexes (NULLs excluded).
DROP INDEX IF EXISTS idx_users_username;
DROP INDEX IF EXISTS idx_users_email;
DROP INDEX IF EXISTS idx_users_phone;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users (username) WHERE username IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users (phone) WHERE phone IS NOT NULL;
