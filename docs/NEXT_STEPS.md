# Next steps after the October 2026 hardening pass

These follow on from PR #129, in priority order. Steps 1 and 2 need access to the
Google Cloud, AWS and Cloudflare accounts. **No secret values belong in this file.**

---

## 1. Rotate leaked credentials — today

The repository is public, so assume anything in its history has already been copied.
Deleting files does not undo that; rotating the keys does.

| What | Where it is in history |
|---|---|
| Firebase Admin SDK private key (project `tophuntdpcontest`) | `apps/admin/scripts/serviceAccountKey.json` — added in `e09853b`, deleted in `d9c606f` |
| AWS access key pair (`S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`) | `functions.tar.gz` → `apps/functions/.env`, commit `d6c00bf` |
| Email password, Twilio auth token | same `.env` |
| `ADMIN_PROXY_SECRET` | `PRODUCTION_AUDIT.md` notes it "was given in chat" |

**Firebase Admin key**

1. Check whether the Worker's `FIREBASE_SERVICE_ACCOUNT` secret is this same key. If it
   is, deleting it first will break sign-in in production.
2. Google Cloud Console → IAM → Service Accounts → `firebase-adminsdk-…` → **Keys** →
   **Add key** (JSON).
3. `cd apps/worker && npx wrangler secret put FIREBASE_SERVICE_ACCOUNT` and paste the new JSON.
4. Check that `/health/deep` is OK and that sign-in works.
5. Delete the old key (the one committed in `e09853b`).
6. In Cloud Logging, look for activity by that service account you don't recognise.

**AWS key**: IAM → Users → Security credentials → deactivate, then delete. Check
CloudTrail for use by anyone else.

**Others**: rotate the Twilio auth token, the email password and `ADMIN_PROXY_SECRET`.

**Optional**: remove the files from history with `git filter-repo` and a force push.
Forks and existing clones keep their copies, so this is cleanup on top of rotation,
not a replacement for it.

---

## 2. Fix backups

Every scheduled run of `backup-d1.yml` (2026-08-30 → 2026-10-11) failed with
Cloudflare error `7404 database … could not be found`. The token and account ID in the
GitHub secrets do not belong to the account that owns `tophunt-db` (the account in
`apps/worker/wrangler.toml` → `CF_ACCOUNT_ID`). **No backup has ever been produced.**

1. In the Cloudflare account that owns `tophunt-db`, create an API token with:
   - Account → D1 → Edit
   - Account → Workers Scripts → Edit (only if the same token is used for deploys)
   - User → Memberships → Read (missing this is why the deploy workflow failed in August)
   - Account → R2 → Edit (only if you use an R2 backup bucket)
2. GitHub → Settings → Secrets: set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
   to the new token and that account's ID.
3. Recommended: create an R2 bucket for backups and set `BACKUP_R2_BUCKET`. For a truly
   off-site copy, put it in a different Cloudflare account. Without it the only copy is
   a 90-day GitHub workflow artifact.
4. Off-peak (the export briefly makes the database unavailable):
   `gh workflow run backup-d1.yml`
5. Confirm the **Preflight** and **Restore test** steps pass and the job summary shows
   real user and ledger counts. Only then do working backups exist.

---

## 3. Merge PR #129 and test on staging

1. **Staging is not set up yet**: `wrangler.toml` still has
   `database_id = "REPLACE_WITH_STAGING_D1_ID"`. Run
   `npx wrangler d1 create tophunt-db-staging` and put the new ID there.
2. Before deploying, list the admins. Admin role must be present in the D1 `users`
   table, and demoting someone now signs them out of every device:
   ```bash
   npx wrangler d1 execute tophunt-db --remote \
     --command "SELECT uid, role FROM users WHERE role IN ('admin','superadmin','moderator')"
   ```
3. Razorpay dashboard:
   - Turn on **automatic capture**. Without it, top-ups now show as "pending" until the
     webhook arrives.
   - The webhook must send `payment.captured`, `order.paid`, `refund.created`,
     `refund.processed`, `payment.dispute.created`, `payment.dispute.lost`.
4. `npx wrangler deploy --env staging`, then smoke-test with Razorpay **test** keys:
   - top-up
   - refund, then confirm the coins were taken back
   - withdrawal request → approve → mark paid
   - chat
   - vote
5. Deploy to production through the deploy workflow. It will fail until the token from
   step 2 is in place.

---

## 4. Keep unverified rewarded ads off

Do **not** set `ALLOW_UNVERIFIED_AD_REWARDS` in production. Turning on the admin panel's
"Credit without server-side verification" toggle alone no longer credits anything. Only
add the variable once an ad network's server-side verification callback is what credits
the reward.

---

## 5. Android release

1. Remove the microphone permission the app never uses (nothing in the app records audio):
   - `android.permission.RECORD_AUDIO` in `apps/expo/app.json`
   - `recordAudioAndroid: true` in the `expo-camera` plugin
   - microphone permission from the `expo-audio` plugin
   - the iOS `NSMicrophoneUsageDescription` text

   Store review can flag permissions that aren't used.
2. `eas build -p android --profile production` (the version code increments automatically).
3. Test on a real device: sign-in, push-notification taps, top-up checkout, camera and
   photo picker.

---

## Known risks not fixed in PR #129

- The vote device ID is generated by the app, so it does not stop one person voting from
  many accounts; only per-account dedup is enforced.
- `/media/*` files are public to anyone who has the URL.
- Accounts pending deletion can still upload files and open realtime connections.
- `/health/deep` checks that secrets are set, not that they work.
