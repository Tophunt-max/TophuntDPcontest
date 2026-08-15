-- Manual deposit (top-up) requests via QR/UPI: the user pays externally to the
-- admin's QR/UPI, enters the bank UTR reference, and the admin approves/rejects.
-- Auto (Razorpay) top-ups keep using the payments table + /api topup.
CREATE TABLE IF NOT EXISTS deposits (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  amount REAL NOT NULL,              -- coins to credit on approval
  pay_amount REAL DEFAULT 0,         -- INR the user paid (amount * coinRate)
  method TEXT DEFAULT 'qr',          -- qr | upi | bank
  utr TEXT,                          -- user-entered bank transaction reference
  screenshot_url TEXT,               -- optional payment screenshot
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  admin_note TEXT,
  processed_by TEXT,                 -- admin uid who actioned it
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deposits_status ON deposits (status, created_at);
CREATE INDEX IF NOT EXISTS idx_deposits_user ON deposits (user_id);
