# Registration verification reward

**Rule (defaults):** 10 coins at signup. When BOTH the email address and the mobile
number are verified, 90 more coins, once. Total 100. Verifying only one unlocks nothing.

Users see: *"Register karne par 10 coins milte hain. Email aur mobile number dono verify
karne par additional 90 coins milenge. Total reward: 100 coins."*

## How it works

| Piece | Where |
|---|---|
| Config, eligibility, atomic credit, status, reminders | `apps/worker/src/lib/verificationReward.ts` |
| Schema (enrolment + anti-farming claims) | `apps/worker/migrations/0054_verification_reward.sql` |
| Signup grant + enrolment (one batch with the profile insert) | `createUserProfile` in `apps/worker/src/routes/auth.ts` |
| Bonus attempted after every successful proof | `verifyEmailOtp`, `verifyPhoneOtp`, `phoneSignIn` in `routes/auth.ts` |
| Status | `GET /read/me/verification` |
| Actions | `/api`: `refreshVerification`, `claimVerificationReward`, `markVerificationPromptShown` |
| Admin | `POST /admin/app-settings` (`verificationReward`, validated + audited), `GET /admin/verification-reward` (config + counters) |
| App | `VerificationRewardPopup` (mounted in `app/_layout.tsx`), `app/profile/manage/verification.tsx`, Manage Profile → "Verify Email & Mobile" |

**Verification evidence (server-side only).** "Verified" means `users.email_verified` /
`users.phone_verified` (migration 0040). These are set only by:
- our 6-digit OTP to the email/number on file (`sendEmailOtp`/`sendPhoneOtp` → `verify*Otp`,
  verify-only mode for the current value), sent via the configured email/SMS provider;
- phone OTP sign-in;
- `refreshVerification`, which reads Firebase's own user record **server-to-server**
  (`accounts:lookup` with the service account) and accepts `emailVerified` only for the
  exact address on the profile, and `phoneNumber` only if it is the same number. This
  is what credits the Firebase email link already sent at signup.

Client-sent flags, uids and amounts are ignored. ID-token claims are not used for this.

**Exactly once.** The credit is one D1 batch. Every statement re-checks: enrolled and not
completed; both flags set on the *same* email/phone the check read; account active and not
blocked; neither identifier already rewarded on another account. The ledger id is
deterministic (`verification_bonus:<uid>`), and the balance moves only if that row is
absent. Retries, duplicate events and concurrent calls credit at most once. The
registration grant keeps the historical id `signup_bonus:<uid>`.

**Anti-farming.** `verification_reward_claims` stores a SHA-256 of the canonical email
(lowercase, `+tag` stripped, Gmail dots removed) and phone (digits; bare 10-digit = +91).
A number or mailbox that has earned the bonus once can never earn it again, including
after account deletion (the hashes are retained; this is listed in the privacy policy).

**Amounts are snapshotted** into the user's enrolment row at signup, so later config
changes never re-price a promise already shown. Disabling the feature *pauses*
completion credits (promises kept); new signups then get the legacy
`rewardSettings.signupBonus`.

**Reminders** are server-side (`prompt_count`, `last_prompt_at`): shown right after
signup, then 3 days after the first showing, then every 7 days, at most 5 showings, never
after completion. A showing is recorded when the popup opens, with a 10-minute de-dupe so
several devices count once. In-app only; no SMS or email reminders.

## Existing users

**No existing account is enrolled.** Until this release signup credited the full
`signupBonus` (default 100) with no verification requirement, and the amount was
admin-configurable over time, so per-user entitlement cannot be reconstructed reliably.
Existing users keep their balances and ledger history; nobody is credited or debited by
the migration. They can still verify from Profile (status shows without a reward offer).
If a backfill is ever wanted, it should be an explicit, audited admin job, not a migration.

## Required setup (not verifiable from the repo)

- **Email OTP:** an email provider configured in Admin → Integrations (Resend / Brevo /
  Maileroo). Without one, `sendEmailOtp` fails closed.
- **SMS OTP:** an SMS provider configured (Twilio / MSG91 / Fast2SMS / …). DLT template
  registration is needed for India.
- **Firebase refresh path:** the Worker's `FIREBASE_SERVICE_ACCOUNT` must be allowed to call
  Identity Toolkit `accounts:lookup` (Firebase Authentication Admin role). If it can't, refresh
  quietly falls back to the OTP path.
- **Firebase email link** (already sent at signup): the app's domain must be in Firebase →
  Authentication → Authorized domains.
- Firebase Phone Auth / SHA fingerprints are **not** required: mobile verification uses the
  project's own OTP over the configured SMS provider, not Firebase Phone Auth.

## Staging checklist

1. Apply migrations to the **staging** database only (the Worker applies them on first request).
2. Sign up a new account. Expect a balance of 10, ledger `signup_bonus:<uid>`, and the popup on home.
3. Verify email only, then check: balance still 10, progress 10/100.
4. Verify mobile: expect "Reward unlocked", balance 100, ledger `verification_bonus:<uid>`.
5. Tap verify/claim again. The balance must not change.
6. Sign up a second account with the same mobile number in another format, then verify it. Expect no bonus.
7. Tap "Remind me later" and reopen the app. The popup must not show again in this session or before 3 days.
8. Admin → App Settings: an invalid config (for example 50 + 90 > 100) is rejected. A valid change appears in the Audit Log.
9. `GET /admin/verification-reward` counters match.

## Tests

```bash
cd apps/worker && npx vitest run test/verificationReward.test.ts   # 38 tests
cd apps/expo   && npx vitest run test/verificationReward.test.ts   # 5 tests
```
