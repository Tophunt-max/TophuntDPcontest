-- Referral program (lib/referralProgram.ts).
--
-- A referral used to be one row written and paid the moment the new account
-- finished signup. That is the cheapest thing to farm: make an account, enter a
-- code, collect, repeat. Real-money apps (Dream11, MPL, Zupee, PhonePe …) pay a
-- referral only once the invited user does something real — so a referral now
-- has a lifecycle:
--
--   pending   code applied; waiting for the qualifying action (e.g. first contest)
--   review    qualified, held for an admin (when the program requires review)
--   rewarded  both sides paid (referrer subject to caps)
--   rejected  fraud check or an admin said no (reason recorded)
--   expired   the invited user did not qualify in time
--
-- Existing rows were paid instantly under the old rule, so they are `rewarded`.
ALTER TABLE referrals ADD COLUMN status TEXT NOT NULL DEFAULT 'rewarded';
ALTER TABLE referrals ADD COLUMN code TEXT;
ALTER TABLE referrals ADD COLUMN referrer_reward REAL NOT NULL DEFAULT 0;
ALTER TABLE referrals ADD COLUMN referee_reward REAL NOT NULL DEFAULT 0;
ALTER TABLE referrals ADD COLUMN qualify_action TEXT;
ALTER TABLE referrals ADD COLUMN qualified_at INTEGER;
ALTER TABLE referrals ADD COLUMN rewarded_at INTEGER;
ALTER TABLE referrals ADD COLUMN expires_at INTEGER;
ALTER TABLE referrals ADD COLUMN reject_reason TEXT;
-- Device the code was applied from: one paid referral per device, and never from
-- the referrer's own device.
ALTER TABLE referrals ADD COLUMN device_id TEXT;
ALTER TABLE referrals ADD COLUMN decided_by TEXT;
ALTER TABLE referrals ADD COLUMN updated_at INTEGER;
UPDATE referrals
   SET referrer_reward = COALESCE(bonus, 0),
       referee_reward = COALESCE(bonus, 0),
       rewarded_at = created_at,
       qualify_action = 'signup',
       updated_at = created_at
 WHERE status = 'rewarded' AND rewarded_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_referrals_status_expires ON referrals (status, expires_at);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer_status ON referrals (referrer_uid, status, rewarded_at);
CREATE INDEX IF NOT EXISTS idx_referrals_device ON referrals (device_id) WHERE device_id IS NOT NULL;

-- The device an account last acted from (sent by the app on signup, code apply
-- and contest entry). Used only for referral fraud checks.
ALTER TABLE users ADD COLUMN device_id TEXT;
