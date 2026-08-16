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
import { eq } from "drizzle-orm";
import type { Env } from "../types";
import { getDb, schema } from "../db";
import { httpsError } from "./http";

/** Strip everything except digits and a leading '+' (E.164-ish). */
export function normalizePhone(phone?: string | null): string | null {
  if (!phone) return null;
  return phone.replace(/[^\d+]/g, "").trim() || null;
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
  const checks: Array<{ col: any; val: string | null; field: string }> = [
    {
      col: schema.users.username,
      val: ids.username ? String(ids.username).toLowerCase() : null,
      field: "Username",
    },
    {
      col: schema.users.email,
      val: ids.email ? String(ids.email).toLowerCase() : null,
      field: "Email",
    },
    { col: schema.users.phone, val: normalizePhone(ids.phone), field: "Phone number" },
  ];
  for (const { col, val, field } of checks) {
    if (!val) continue;
    const row = await db
      .select({ uid: schema.users.uid })
      .from(schema.users)
      .where(eq(col, val))
      .get();
    if (row && row.uid !== uid) throw httpsError("already-exists", `${field} is already in use.`);
  }
}
