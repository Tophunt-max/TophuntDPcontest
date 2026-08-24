-- Panel-managed third-party credentials.
--
-- API keys for the SMS gateway, email provider, payment gateway and video CDN
-- were Cloudflare Worker secrets only, which meant switching provider or rotating
-- a key required CLI access and a deploy. Operations teams need to do both from
-- the admin panel.
--
-- Storing them as plaintext rows would be the easy version and a bad one: any
-- read primitive against this table would hand over every credential at once. So
-- values are AES-256-GCM encrypted (lib/secretBox.ts) with a key that stays a
-- Cloudflare secret (SETTINGS_ENCRYPTION_KEY) and is never written here. The
-- database on its own is therefore useless, and the API never returns a stored
-- value — only `fingerprint` and `hint`, which are non-reversible.
--
-- Resolution order at runtime is panel value first, environment second, so
-- existing deployments keep working and credentials migrate one at a time.
CREATE TABLE IF NOT EXISTS integration_secrets (
  name        TEXT PRIMARY KEY,
  ciphertext  TEXT NOT NULL,
  iv          TEXT NOT NULL,
  fingerprint TEXT,
  hint        TEXT,
  updated_by  TEXT,
  updated_at  INTEGER NOT NULL
);
