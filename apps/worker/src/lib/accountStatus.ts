/**
 * `users.status` values that the auth layer and the deletion lifecycle must
 * agree on, in a module with no imports.
 *
 * These live here rather than in lib/accountDeletion.ts because
 * middleware/auth.ts needs them, and the deletion library pulls in D1, Bunny,
 * Firebase, KV and the settings store — none of which the auth path should have
 * to load in order to compare two strings.
 */

/** A deletion has been requested and the grace period has not lapsed yet. */
export const PENDING_DELETION_STATUS = "pending_deletion";

/** The row has been anonymised. Terminal: nothing moves out of this state. */
export const DELETED_STATUS = "deleted";

/** An admin has blocked the account. */
export const BLOCKED_STATUS = "blocked";

/**
 * `/api` actions that must stay reachable even when the account is blocked.
 *
 * Both app stores require an in-app way to delete an account, and the auth
 * middleware rejected every request from a blocked account before the router
 * ever saw the action name. The client, receiving a 403 on the eligibility
 * check, rendered an error and hid its own delete button — so a blocked user had
 * no deletion path at all, which is precisely the compliance hole this feature
 * was built to close.
 *
 * Being blocked is also exactly when someone is most likely to want out, so this
 * is the wrong place to be strict. None of these actions can affect another
 * user, spend money, or publish anything.
 */
export const SELF_SERVICE_ACTIONS: ReadonlySet<string> = new Set([
  "accountDeletionStatus",
  "requestAccountDeletion",
  "cancelAccountDeletion",
  "deleteAccount",
  "exportMyData",
]);

/**
 * `/api` actions still permitted while a deletion is pending.
 *
 * Everything else is refused. Once a user has asked to be deleted, the account
 * is out of service: it is hidden from every public read path and told to the
 * user as gone. Letting it keep posting, voting, messaging or spending in the
 * meantime would make that a lie, and would create data during the grace period
 * that the purge was never told about.
 *
 * Reads are unaffected — they run through `requireAuth`, not this list — because
 * the user has to be able to see the "scheduled for deletion" screen in order to
 * cancel from it.
 */
/** Grace period used when the setting is absent or unusable. */
export const DEFAULT_DELETION_GRACE_DAYS = 30;

/**
 * Read the configured grace period, clamped.
 *
 * Shared by lib/accountDeletion.ts (which enforces it) and content/legal.ts
 * (which states it in the privacy policy). Two copies of this parsing would
 * eventually disagree, and the failure mode is a policy that promises a window
 * the server does not honour.
 *
 * The type guard is not decoration. `Number(null)` is `0`, and `0` is a VALID
 * value here meaning "purge on the next tick" — so a setting that was explicitly
 * nulled, or set to `''` or `[]`, would have been read as "erase everything
 * immediately, no grace period". Only a real, finite number counts.
 *
 * 0 is allowed on purpose: some support escalations and some jurisdictions do
 * want immediate erasure. The upper clamp stops a typo turning deletion into a
 * year-long limbo.
 */
export function parseGraceDays(raw: unknown): number {
  if (typeof raw !== "number" && typeof raw !== "string") return DEFAULT_DELETION_GRACE_DAYS;
  if (typeof raw === "string" && raw.trim() === "") return DEFAULT_DELETION_GRACE_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_DELETION_GRACE_DAYS;
  return Math.min(Math.max(Math.floor(n), 0), 90);
}

export const PENDING_DELETION_ALLOWED_ACTIONS: ReadonlySet<string> = new Set([
  ...SELF_SERVICE_ACTIONS,
  // Detaching this device's push token is part of signing out cleanly, and a
  // user signing out of an account that is pending deletion is the normal case.
  "unregisterFcmToken",
  "markNotificationsRead",
]);
