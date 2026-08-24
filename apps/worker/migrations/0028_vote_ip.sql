-- Record the voter's IP so vote fraud can actually be investigated.
--
-- The per-IP velocity cap already existed, but the IP itself was never stored:
-- the `votes` table (and the Durable Object's local `voters` table) only carried
-- `device_id`, so /admin/fraud/votes could correlate devices and nothing else,
-- and post-hoc network analysis was impossible.
--
-- Note this is deliberately NOT a blocking dedup key. Indian mobile carriers NAT
-- very large numbers of subscribers behind one address, so a hard per-IP cap per
-- match would reject legitimate voters. It is an investigation signal.
ALTER TABLE votes ADD COLUMN ip TEXT;

-- "which accounts voted from this address in this match" is the fraud query.
CREATE INDEX IF NOT EXISTS idx_votes_match_ip ON votes(match_id, ip);
