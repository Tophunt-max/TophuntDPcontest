-- Admin panel features: payout/withdrawal management + admin audit trail.

-- Withdrawal requests: users request a cash payout of their Dpcoin balance,
-- admins approve/reject from the panel. Coins are held (deducted) at request
-- time and refunded if the request is rejected.
CREATE TABLE IF NOT EXISTS withdrawals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  amount REAL NOT NULL,                 -- Dpcoins requested
  cash_amount REAL DEFAULT 0,           -- INR/local value (amount * rate)
  method TEXT DEFAULT 'upi',            -- upi | bank | paytm ...
  account_details TEXT,                 -- UPI id / bank details (JSON or text)
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | paid
  admin_note TEXT,
  processed_by TEXT,                    -- admin uid who actioned it
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals (status, created_at);
CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawals (user_id);

-- Admin audit trail: every sensitive admin action is recorded here for
-- accountability (who did what, to whom, when).
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id TEXT PRIMARY KEY,
  admin_uid TEXT,
  admin_email TEXT,
  action TEXT NOT NULL,                 -- e.g. user.block, wallet.adjust, contest.delete
  target_type TEXT,                     -- user | contest | match | withdrawal ...
  target_id TEXT,
  detail TEXT,                          -- JSON blob with extra context
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON admin_audit_log (created_at);
CREATE INDEX IF NOT EXISTS idx_audit_action ON admin_audit_log (action);
