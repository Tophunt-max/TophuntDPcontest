-- Make `users.signup_completed` trustworthy, so it can gate the app.
--
-- Until now it was only ever SET by the proper signup paths (createUserProfile),
-- while every completeness check — client and server — read
-- `signup_completed OR username`. That shortcut let a bug through: the client's
-- `useProfile` hook auto-created a default profile (bio 'Hi there! I am new
-- here.', username derived from the provider display name) for a social/phone
-- user who left onboarding with Back, and because that row HAD a username it
-- counted as a finished account everywhere — no age gate, no welcome bonus, no
-- verification enrolment.
--
-- From this release the server gates on `signup_completed` alone. Before that
-- can be switched on, every account that really finished signing up must have
-- the flag set, or a legitimate (older) user would be sent back to onboarding:
--
--   * a username, AND
--   * NOT the auto-created signature: the default bio with no date of birth and
--     no gender. Those three fields are only written together by the onboarding
--     form; the auto-create wrote the bio and never the other two. An account
--     that later filled them in through Edit Profile is treated as finished.
--
-- Rows left at 0 are exactly the half-created accounts. Nothing is deleted:
-- their owner is taken through onboarding on next use, with the existing values
-- pre-filled, and `createProfile` completes the SAME row.
UPDATE users
   SET signup_completed = 1
 WHERE COALESCE(signup_completed, 0) = 0
   AND username IS NOT NULL AND TRIM(username) <> ''
   AND NOT (
         COALESCE(bio, '') = 'Hi there! I am new here.'
     AND dob IS NULL
     AND gender IS NULL
   );
