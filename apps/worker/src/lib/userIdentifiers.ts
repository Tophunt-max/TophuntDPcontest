/**
 * Shared uniqueness enforcement for the user identifiers that must be globally
 * unique: username, email, phone.
 *
 * This is the application-level guard that backs the partial UNIQUE indexes
 * (migration 0012). Every write path that can SET one of these fields must call
 * it — otherwise duplicates slip in and only surface as an ugly raw SQLite
 * "UNIQUE constraint failed" 500 (or, if the index isn't deployed, not at all).
 *
 * Used by:
 *   - routes/auth.ts   → createUserProfile (signup: create / createProfile)
 *   - routes/api.ts    → updateProfile (profile edit)
 */
import { eq, sql } from "drizzle-orm";
import type { Env } from "../types";
import { getDb, schema } from "../db";
import { isHiddenAccountStatus } from "./accountStatus";
import { httpsError } from "./http";

/** Strip everything except digits and a leading '+' (E.164-ish). */
export function normalizePhone(phone?: string | null): string | null {
  if (!phone) return null;
  return phone.replace(/[^\d+]/g, "").trim() || null;
}

/**
 * Usernames reserved for the platform. Impersonating one of these ("support",
 * "official", "moderator") is a phishing vector inside the app's own DMs.
 */
export const RESERVED_USERNAMES = new Set([
  "admin", "administrator", "root", "system", "support", "help", "info",
  "contact", "webmaster", "security", "privacy", "policy", "terms", "login",
  "logout", "signin", "signup", "register", "auth", "user", "users", "profile",
  "settings", "config", "api", "dev", "test", "null", "undefined", "true",
  "false", "void", "anon", "anonymous", "official", "staff", "moderator",
]);

const USERNAME_REGEX = /^[a-zA-Z0-9_.]+$/;

/**
 * The single username policy for the whole backend.
 *
 * This lived privately inside routes/auth.ts, so the admin profile-edit route
 * wrote `username` with nothing but `.toLowerCase()` — bypassing the length,
 * character-set and reserved-name rules that signup enforces. Any write path
 * that can SET a username must call this.
 */
export function validateUsername(username: string): string {
  const value = String(username ?? "").trim();
  const lower = value.toLowerCase();
  if (lower.length < 3) throw httpsError("invalid-argument", "Username must be at least 3 characters long.");
  if (lower.length > 30) throw httpsError("invalid-argument", "Username must be less than 30 characters long.");
  if (!USERNAME_REGEX.test(value))
    throw httpsError("invalid-argument", "Username can only contain letters, numbers, underscores, and dots.");
  if (RESERVED_USERNAMES.has(lower)) throw httpsError("invalid-argument", "This username is reserved and cannot be used.");
  // Return the value with its ORIGINAL case preserved for display. Uniqueness is
  // still case-insensitive — the DB unique index is COLLATE NOCASE (migration
  // 0041) and assertIdentifiersAvailable compares lower()=lower() — so "Alice"
  // and "alice" are the same name, but "Alice" is what is shown.
  return value;
}

/**
 * Throws `already-exists` if any provided identifier is already used by a
 * DIFFERENT uid. Passing the caller's own uid is fine (updating their own row).
 * Undefined/empty identifiers are skipped.
 */
export async function assertIdentifiersAvailable(
  env: Env,
  uid: string,
  ids: { username?: string | null; email?: string | null; phone?: string | null },
): Promise<void> {
  const db = getDb(env);
  const checks: Array<{ col: any; val: string | null; field: string; caseInsensitive?: boolean }> = [
    {
      col: schema.users.username,
      // Compared case-insensitively (see below), so keep the typed case here.
      val: ids.username ? String(ids.username).trim() : null,
      field: "Username",
      caseInsensitive: true,
    },
    {
      col: schema.users.email,
      val: ids.email ? String(ids.email).toLowerCase() : null,
      field: "Email",
    },
    { col: schema.users.phone, val: normalizePhone(ids.phone), field: "Phone number" },
  ];
  for (const { col, val, field, caseInsensitive } of checks) {
    if (!val) continue;
    // Username uniqueness is case-insensitive ("Alice" == "alice"), matching the
    // COLLATE NOCASE unique index; email/phone are already normalised so a plain
    // equality is right for them.
    const predicate = caseInsensitive ? sql`lower(${col}) = lower(${val})` : eq(col, val);
    const row = await db
      .select({ uid: schema.users.uid })
      .from(schema.users)
      .where(predicate)
      .get();
    if (row && row.uid !== uid) throw httpsError("already-exists", `${field} is already in use.`);
  }

  // Nobody holds the name right now — but it may have been released so recently
  // that links to it are still circulating. Checked HERE, inside the function every
  // write path already has to call, rather than as a separate guard a new caller
  // could forget.
  if (ids.username) await assertUsernameNotOnHold(env, uid, String(ids.username));
}

/**
 * How long a released username is unavailable to ANYONE ELSE.
 *
 * The window exists because the public profile url is `/@username`. When a handle
 * is released, links to it are already out in the world — in chats, bios, QR codes
 * and screenshots — and whoever claims it next inherits all of that traffic. Without
 * a hold, the sequence is: watch for a rename, claim the freed handle within
 * seconds, and every previously-shared link now opens YOUR profile. The link still
 * works and still looks right, which is what makes it worse than a dead link.
 *
 * Thirty days is chosen against the thing being protected rather than picked round.
 * This product moves wallets, contest entry fees and prize payouts, so the
 * impersonation being prevented has a direct financial path — someone posing as a
 * known creator asking people to enter "their" contest. A month is long enough for
 * shared links to go cold and for the original owner to change their mind, and it
 * costs nothing except that a handle someone abandoned is not instantly recyclable.
 *
 * The original owner is exempt: `assertUsernameNotOnHold` compares uids, so
 * renaming back is always allowed. That matters — the most common reason to want a
 * just-released handle is that the rename was a mistake.
 */
export const USERNAME_HOLD_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Refuse a username that a DIFFERENT account released inside the hold window.
 *
 * Fails CLOSED on a lookup error, unlike most guards in this codebase. The usual
 * argument for failing open — a transient blip must not stop people using the app —
 * points the other way here: the cost of refusing a username for one request is
 * that someone retries a profile edit, while the cost of allowing one wrongly is a
 * handle takeover that cannot be undone once links start resolving to it.
 */
export async function assertUsernameNotOnHold(
  env: Env,
  uid: string,
  username: string,
): Promise<void> {
  const lower = String(username ?? "").trim().toLowerCase();
  if (!lower) return;

  let row: { uid: string; releasedAt: number } | undefined;
  try {
    row = await getDb(env)
      .select({ uid: schema.usernameHistory.uid, releasedAt: schema.usernameHistory.releasedAt })
      .from(schema.usernameHistory)
      .where(eq(schema.usernameHistory.usernameLower, lower))
      .get();
  } catch (e) {
    console.error("[username] hold lookup failed (refusing the claim)", lower, e);
    throw httpsError("internal", "We couldn't verify that username right now. Please try again.");
  }

  if (!row) return;
  // The previous owner may always take their own handle back.
  if (row.uid === uid) return;
  if (Date.now() - Number(row.releasedAt) >= USERNAME_HOLD_MS) return;

  // Deliberately does NOT say who held it or when it frees up. That would turn this
  // into a monitor for "handles about to become available", which is precisely the
  // behaviour the hold window exists to discourage.
  throw httpsError("already-exists", "Username is already in use.");
}

/**
 * Move the history table from before a rename to after it: `uid` gives up
 * `previousUsername` and takes `newUsername`.
 *
 * ---------------------------------------------------------------------------
 * Why one function and not two
 * ---------------------------------------------------------------------------
 * A rename is a release AND a claim, and the claim half is easy to forget because
 * nothing appears to depend on it. It does. Nothing else ever deletes a history row
 * for a handle that someone has since taken, so a superseded row sits there looking
 * inert — live owner always wins — right up until that owner stops holding the name in
 * a way that records no release. Then it becomes authoritative again:
 *
 *   A holds `alice`, renames away          → history: alice -> A
 *   B legitimately claims `alice` later     → history: alice -> A   (untouched)
 *   B's account is deleted                  → purge deletes WHERE uid = B; the alice
 *                                             row belongs to A, so it survives
 *   GET /@alice                             → movedTo: A's current handle
 *
 * Every link shared while B held `/@alice` now redirects to A. Deleting the row on the
 * claim is what makes the invariant true and keeps it true: A ROW EXISTS ONLY FOR A
 * HANDLE THAT NOBODY HAS HELD SINCE IT WAS RELEASED.
 *
 * ---------------------------------------------------------------------------
 * Ordering, and why this must run BEFORE the users row is written
 * ---------------------------------------------------------------------------
 * This used to run after, which left a window — small, but pollable at whatever rate
 * the WAF allows — in which the old handle was live-free and hold-free, so a concurrent
 * claim from another account passed both `assertIdentifiersAvailable` and
 * `assertUsernameNotOnHold` and took it. Sniping a handle the instant it frees is the
 * precise attack the hold window exists to prevent, so the guard cannot be published
 * after the thing it guards.
 *
 * Running first is safe in the failure direction: if the rename then fails, the history
 * row says this uid released a handle it still holds, which is completely inert —
 * `resolveUsername` prefers the live owner, and `assertUsernameNotOnHold` exempts the
 * uid on the row. A spurious hold can only ever block OTHER accounts from a name that
 * is not free anyway.
 *
 * ---------------------------------------------------------------------------
 * And why this one THROWS
 * ---------------------------------------------------------------------------
 * The opposite of what it did before, on purpose. While it ran after the write, failing
 * the request would have reported a completed rename as failed, so swallowing the error
 * was the lesser evil — but it meant a D1 blip left the handle permanently free with
 * every link to it dead, since nothing ever recreates the row.
 *
 * Running first removes that trade-off entirely: nothing has been committed yet, so
 * throwing leaves a consistent state and costs the user one retry. Same reasoning as
 * `assertUsernameNotOnHold`, which also fails closed — and it only ever affects an edit
 * that actually changes a username, never a bio or avatar edit.
 */
export async function recordUsernameTransition(
  env: Env,
  uid: string,
  previousUsername: string | null | undefined,
  newUsername: string | null | undefined,
): Promise<void> {
  const released = String(previousUsername ?? "").trim().toLowerCase();
  const claimed = String(newUsername ?? "").trim().toLowerCase();

  // A display-case change ("alice" -> "Alice") is the same handle. Releasing it would
  // put a user's own name on hold against them and make `/@alice` a redirect to itself.
  if (released && claimed && released === claimed) return;
  if (!released && !claimed) return;

  const db = getDb(env);
  const statements: any[] = [];

  // The claim: this handle now has a live owner, so any record of a past one is stale.
  if (claimed) {
    statements.push(db.delete(schema.usernameHistory).where(eq(schema.usernameHistory.usernameLower, claimed)));
  }

  // The release. Upsert on the handle, so the MOST RECENT owner is the one an unclaimed
  // handle leads back to — keeping every past owner would let an ancient one win over a
  // recent one, the opposite of what a reader of an old link expects.
  if (released) {
    statements.push(
      db
        .insert(schema.usernameHistory)
        .values({ usernameLower: released, uid, releasedAt: Date.now() })
        .onConflictDoUpdate({
          target: schema.usernameHistory.usernameLower,
          set: { uid, releasedAt: Date.now() },
        }),
    );
  }

  if (!statements.length) return;
  try {
    // One batch, so a release is never recorded without its matching claim being
    // cleared. D1 runs a batch as a single transaction.
    await db.batch(statements as [any, ...any[]]);
  } catch (e) {
    console.error("[username] transition failed (refusing the rename)", { uid, released, claimed }, e);
    throw httpsError("internal", "We couldn't update that username right now. Please try again.");
  }
}

/** Where a `/@handle` lookup landed. */
export interface UsernameResolution {
  uid: string;
  /** The handle this account holds NOW. Null if it somehow has none. */
  currentUsername: string | null;
  /**
   * True when the requested handle is a RELEASED one and the caller should redirect
   * to `currentUsername` rather than render. False for a live handle.
   */
  moved: boolean;
}

/**
 * Resolve a `/@handle` to an account.
 *
 * CURRENT OWNER ALWAYS WINS. History is only consulted when nobody holds the handle
 * today, which makes a history row a fallback and never an override — without that
 * ordering, this table would be a way to hijack a name that has since been
 * legitimately re-registered.
 *
 * Returns null when the handle is unknown, or when it is only known from history but
 * that account no longer has a handle to redirect to.
 */
export async function resolveUsername(
  env: Env,
  username: string,
): Promise<UsernameResolution | null> {
  const lower = String(username ?? "").trim().toLowerCase();
  if (!lower) return null;
  const db = getDb(env);

  const live = await db
    .select({ uid: schema.users.uid, username: schema.users.username })
    .from(schema.users)
    .where(sql`lower(${schema.users.username}) = ${lower}`)
    .get();
  // No status filter on the LIVE lookup, deliberately: a hidden account still HOLDS its
  // handle, so it must still outrank history. The caller decides what a hidden target
  // is allowed to disclose (`serveUserProfile` answers null); pretending the handle is
  // unheld here would hand it to the history fallback and redirect elsewhere.
  if (live) return { uid: live.uid, currentUsername: live.username ?? null, moved: false };

  const past = await db
    .select({ uid: schema.usernameHistory.uid })
    .from(schema.usernameHistory)
    .where(eq(schema.usernameHistory.usernameLower, lower))
    .get();
  if (!past) return null;

  /**
   * The account that released the handle — is it still somewhere worth pointing at?
   *
   * `status` is checked, and that check is not defensive tidiness. Deletion anonymises
   * the row by writing `username: "deleted_…"` rather than clearing it
   * (`executeAccountDeletion`), and `purgeUsernameHistory` swallows its own errors by
   * design. So without this, one failed purge turns `/@theirOldHandle` into a redirect
   * to an internal anonymised handle — a hop into a 404 that also confirms the account
   * existed. A pending-deletion account leaks the same way: the direct lookup answers
   * null while the pointer names its live handle.
   */
  const owner = await db
    .select({ username: schema.users.username, status: schema.users.status })
    .from(schema.users)
    .where(eq(schema.users.uid, past.uid))
    .get();
  if (!owner?.username) return null;
  if (isHiddenAccountStatus(owner.status)) return null;

  return { uid: past.uid, currentUsername: owner.username, moved: true };
}

/**
 * Drop every released handle belonging to `uid`.
 *
 * Called on account deletion. Without it, `/@theirOldHandle` would keep redirecting
 * to an account that has been anonymised — a link that resolves to a deleted person
 * is worse than one that 404s, and deletion is supposed to make them unreachable.
 */
export async function purgeUsernameHistory(env: Env, uid: string): Promise<void> {
  try {
    await getDb(env)
      .delete(schema.usernameHistory)
      .where(eq(schema.usernameHistory.uid, uid))
      .run();
  } catch (e) {
    console.error("[username] history purge failed (continuing)", uid, e);
  }
}
