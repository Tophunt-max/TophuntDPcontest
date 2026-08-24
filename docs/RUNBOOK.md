# Operations runbook

What to do when something is wrong. Written to be followed under pressure, so each
section starts with the fastest safe action.

---

## 1. Is the system healthy?

```bash
curl -s https://<worker-host>/health/deep | jq
```

`/health` only proves the process is running. `/health/deep` actually exercises D1,
KV and R2, reports which required secrets are missing, and reports whether the cron
is still firing. It returns **503** when anything required is unhealthy, so an
uptime monitor only needs to watch the status code.

| Field | Meaning if failing |
|---|---|
| `checks.d1` | Database binding broken or D1 incident. Nothing that writes will work. |
| `checks.kv_cache` / `kv_otp` | Rate limits and OTP storage degraded. OTP sends will fail. |
| `checks.r2` | Media uploads and serving are broken. |
| `checks.secrets` | Lists the missing ones by name. Each fails a user-visible flow **closed**, so the app looks fine and quietly refuses to work. |
| `checks.integrations` | An SMS/email/payment provider is unconfigured. Check the admin panel → Integrations. |
| `checks.cron` | Settlement, refunds and payment reconciliation have stopped. See §4. |

---

## 2. Payments are failing

**Symptom: users pay but get no coins.**

1. Check `/health/deep` → `checks.secrets`. Without `RAZORPAY_WEBHOOK_SECRET` the
   webhook returns 503 and every payment depends on the client callback alone.
2. The reconciliation sweep runs every 10 minutes and credits anything captured at
   Razorpay but not credited here. Confirm it is running:
   admin panel → **Error Logs**, or query `cron_runs`:
   ```sql
   SELECT job, ok, duration_ms, datetime(created_at/1000,'unixepoch') AS at
     FROM cron_runs ORDER BY created_at DESC LIMIT 20;
   ```
3. Find stuck orders:
   ```sql
   SELECT order_id, user_id, coins, amount_paise, reconcile_attempts, status
     FROM payment_orders
    WHERE status = 'created' AND created_at < (unixepoch()*1000 - 3600000)
    ORDER BY created_at;
   ```
   `reconcile_attempts >= 8` means the sweep gave up — investigate that order by
   hand in the Razorpay dashboard.

**Never** credit coins manually to "fix" a payment without first confirming the
order is not `paid`. Use admin panel → Users → wallet adjust, which is audited and
idempotent (send an `Idempotency-Key`), rather than a direct SQL update.

---

## 3. Suspected fraud or an incident on payouts

**Freeze payouts immediately** — admin panel → App Settings → *Freeze payouts
(emergency)*. This blocks all new payout requests without disabling the feature or
touching anything already in flight.

Then:
- **Vote collusion**: admin panel → Fraud → devices with multiple accounts, and
  *vote networks* (many accounts from one address converging on one entry). Treat
  IP clustering as a signal, not proof — Indian carriers NAT large numbers of real
  users behind one address.
- **Refund farming**: any clawback that could not be fully recovered raises an
  admin notification and sets `payment_orders.clawback_shortfall`. A user with a
  negative balance has spent money they later reversed.
  ```sql
  SELECT user_id, SUM(clawback_shortfall) AS unrecovered
    FROM payment_orders WHERE clawback_shortfall > 0
   GROUP BY user_id ORDER BY unrecovered DESC;
  ```

---

## 4. The cron has stopped

Settlement, refunds, payment reconciliation and retention all run on the 10-minute
trigger. If `checks.cron` reports stale or failing:

1. Look at the last runs (`cron_runs`, query in §2) and the admin **Error Logs**
   page — a failed run writes an error log, a Sentry event and an admin
   notification.
2. Re-run the affected job by hand (both are safe to repeat):
   - `POST /admin/ops/resolve-contests` — settles due matches.
   - `POST /admin/ops/hall-of-fame` — monthly payouts; exactly-once per
     `(period, rank, uid)`, so a double click pays nobody twice. Accepts
     `{"period":"YYYY-MM"}` to re-run a specific month.
3. A single match that will not settle is usually its `VoteCounter` Durable Object
   failing to finalise. Settlement is deliberately **fail-closed** — it would
   rather defer than pay out from a stale vote tally — so the match stays active
   and retries. If it never clears, cancel and refund it:
   `POST /admin/matches/:id/cancel`.

---

## 5. Restoring the database

**Read this before touching anything.** Restoring is destructive and R2 media
deleted after the restore point does **not** come back, so a restored database can
reference media that no longer exists.

### Option A — Time Travel (fastest, last 30 days)

```bash
cd apps/worker
npx wrangler d1 time-travel info tophunt-db
npx wrangler d1 time-travel restore tophunt-db --timestamp=2026-08-24T09:00:00Z
```

### Option B — weekly off-site export

Backups are produced by `.github/workflows/backup-d1.yml`, stored as a workflow
artifact and (when `BACKUP_R2_BUCKET` is set) in R2 under `d1/`.

**Always restore into a NEW database first and inspect it:**

```bash
gunzip tophunt-db-<stamp>.sql.gz
npx wrangler d1 create tophunt-db-restore
npx wrangler d1 execute tophunt-db-restore --remote --file=tophunt-db-<stamp>.sql
# verify, then repoint database_id in wrangler.toml and deploy
```

### After ANY restore

1. **Reconcile the wallet ledger against balances.** A rollback can leave a
   credited payment missing from the ledger:
   ```sql
   SELECT u.uid, u.dpcoin,
          COALESCE((SELECT SUM(amount) FROM coin_transactions t WHERE t.uid = u.uid), 0) AS ledger
     FROM users u
    WHERE ABS(u.dpcoin - COALESCE((SELECT SUM(amount) FROM coin_transactions t WHERE t.uid = u.uid), 0)) > 0
    LIMIT 100;
   ```
   The signup bonus is ledgered, so for accounts created after the ledger was
   introduced these should match exactly.
2. **Durable Object state is NOT covered by any of this.** `VoteCounter` holds
   in-flight vote tallies in its own storage, so after a restore a match may have
   D1 rows that disagree with its actor. Cancel and refund affected in-flight
   matches rather than settling them.
3. Re-check `/health/deep`, and confirm the next cron tick writes a `cron_runs` row.

---

## 6. Rotating credentials

Everything except the encryption key itself can be rotated from admin panel →
**Integrations**, with no deploy. Values are encrypted at rest and never readable
back; the page shows which source (panel or server environment) is actually in
effect.

**`SETTINGS_ENCRYPTION_KEY` is the exception.** Rotating it makes every stored
credential undecryptable:

```bash
# 1. Panel: confirm which credentials are stored (source = "Saved here")
# 2. Set the new key
npx wrangler secret put SETTINGS_ENCRYPTION_KEY
# 3. Re-enter every panel-managed credential immediately
```
Credentials that exist in the Worker environment keep working throughout, because
resolution falls back to the environment.

---

## 7. Rolling back a deploy

```bash
# List recent deployments and roll back
npx wrangler deployments list
npx wrangler rollback --message "reason"
```

Rolling back **code** is safe. Rolling back does **not** undo migrations — they are
applied automatically on first request and are append-only by policy (CI enforces
it), so an older Worker runs against a newer schema. That is normally fine because
migrations only add. If a migration is the problem, fix forward with a new
migration rather than reverting the file.
