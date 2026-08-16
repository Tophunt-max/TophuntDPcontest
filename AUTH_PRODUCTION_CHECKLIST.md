# Auth — Production Checklist

Deployment / configuration steps for the signup / login / password-reset system.
Code-level hardening lives in `apps/worker` and `apps/expo`; the items below are
**console / config actions** that code cannot perform, plus the deploy order.

## 🔴 Must do (config — no code)

### 1. Firebase: one account per email  ⭐ (prevents duplicate accounts)
If a user signs up with email/password and later signs in with Google using the
**same email**, Firebase can create **two separate accounts** unless this is on.

- Firebase Console → **Authentication → Settings → User account linking**
- Select **"Link accounts that use the same email address"**
  (equivalently: enforce **one account per email address**).

Without this, one person can end up with multiple Firebase UIDs for the same
email. The backend prevents duplicate *D1 profiles* (unique indexes +
`assertIdentifiersAvailable`), but the duplicate *Firebase account* can only be
prevented by this setting.

### 2. Firebase email templates (password reset / verification)
The email channel uses Firebase's built-in emails.
- Console → **Authentication → Templates** → set a **custom SMTP / sender
  domain**, branding, and language (default `noreply@<project>.firebaseapp.com`
  often lands in spam).
- Add the reset/verify action domain under **Authentication → Settings →
  Authorized domains**.

### 3. Firebase App Check (bot protection)
`check` / `create` are public (pre-login) endpoints. Enable **App Check**
(reCAPTCHA / Play Integrity / App Attest) to block automated signup abuse. The
Worker already rate-limits these, but App Check stops bots earlier.

## 🟠 Deploy order (each release that touches auth)

1. **Back up D1** (`wrangler d1 export`) before applying migrations.
2. **Deploy the Worker** — migration `0012_auth_unique_identifiers.sql` auto-applies
   on the first request (`ensureMigrated`). It de-duplicates any existing rows
   (usernames suffixed, duplicate phones/emails nulled — non-destructive, no
   account deleted) and then creates the partial UNIQUE indexes. Verify it
   applied cleanly in the logs before relying on DB-level uniqueness.
3. **Ship a new Expo build** — several fixes are client-side (6-digit OTP,
   resumable wizard, follow-someone, forgot-password, social guard).

## ✅ Implemented in code (reference)

- Duplicate identifiers rejected at write time (`create`, `createProfile`,
  `updateProfile`) + partial UNIQUE indexes on username/email/phone.
- Idempotent `create`: a retried/interrupted signup resumes instead of
  dead-ending on `EMAIL_EXISTS`; the signup bonus is granted at most once.
- Rate limiting + per-recipient OTP send cooldown; anti-enumeration on
  forgot-password; server-side password policy; 6-digit phone-reset OTP;
  resumable multi-step signup (password never persisted to disk).

## 🟡 Recommended follow-ups (not yet done)

- Native social login via `expo-auth-session` / Apple auth (currently guarded
  off on native).
- Record Terms acceptance (timestamp + policy version) server-side.
- Signup funnel analytics (per-step drop-off).
- R2 lifecycle policy to clean up avatars uploaded by abandoned signups.
