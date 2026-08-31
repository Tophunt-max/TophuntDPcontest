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
}
