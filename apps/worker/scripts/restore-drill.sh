#!/usr/bin/env bash
# Backup/restore drill, LOCAL ONLY (never touches a Cloudflare account).
#
# Proves that what `wrangler d1 export` writes for this schema can be loaded into
# an EMPTY database by `wrangler d1 execute --file` (the restore path in
# docs/RUNBOOK.md §5), with every table, index and trigger and the seeded rows
# intact. The weekly production backup (.github/workflows/backup-d1.yml) proves
# the same for real data with sqlite3; this catches a schema change that breaks
# the D1 restore path before it ships.
#
# Usage: bash scripts/restore-drill.sh   (from apps/worker; needs sqlite3)
set -euo pipefail

W="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
wr() { npx --prefix "$W" wrangler "$@"; }

for d in source restored; do
  mkdir -p "$T/$d/src"
  cp "$W/wrangler.toml" "$T/$d/"
  cp -r "$W/migrations" "$T/$d/"
  echo 'export default {}' > "$T/$d/src/index.ts"
done

cd "$T/source"
wr d1 migrations apply tophunt-db --local > "$T/migrate.log" 2>&1 || { tail -20 "$T/migrate.log"; exit 1; }
wr d1 execute tophunt-db --local --command \
  "INSERT INTO users (uid, username, created_at, updated_at) VALUES ('drill-u1','drill',1,1);
   INSERT INTO coin_transactions (id, uid, amount, type, created_at) VALUES ('drill-t1','drill-u1',5,'admin_adjustment',1);" > /dev/null
wr d1 export tophunt-db --local --output="$T/dump.sql" > /dev/null
echo "export: $(wc -c < "$T/dump.sql") bytes"

cd "$T/restored"
start=$(date +%s)
wr d1 execute tophunt-db --local --file="$T/dump.sql" -y > "$T/restore.log" 2>&1 || { tail -20 "$T/restore.log"; exit 1; }
echo "restore: $(( $(date +%s) - start ))s"

count() { (cd "$T/$1" && wr d1 execute tophunt-db --local --json --command "$2" 2>/dev/null) | grep -o '"n": [0-9]*' | grep -o '[0-9]*'; }
fail=0
for q in "SELECT COUNT(*) n FROM users" \
         "SELECT COUNT(*) n FROM coin_transactions" \
         "SELECT COUNT(*) n FROM d1_migrations" \
         "SELECT COUNT(*) n FROM sqlite_master WHERE type IN ('table','index','trigger','view')"; do
  a=$(count source "$q"); b=$(count restored "$q")
  echo "$q: source=$a restored=$b"
  if [ -z "$a" ] || [ "$a" != "$b" ]; then fail=1; fi
done

sqlite3 "$T/check.db" < "$T/dump.sql"
integrity=$(sqlite3 "$T/check.db" "PRAGMA integrity_check;")
echo "integrity_check: $integrity"
[ "$integrity" = "ok" ] || fail=1

if [ "$fail" != 0 ]; then echo "::error::Restore drill failed: the restored database differs from the source."; exit 1; fi
echo "Restore drill passed."
